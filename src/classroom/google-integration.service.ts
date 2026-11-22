import type { OAuthTokens, OidcProfile } from "@nestjs/authentication";
import {
	BadGatewayException,
	BadRequestException,
	Injectable,
	Logger,
	ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectDrizzle } from "@nestjs/drizzle";
import { eq } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { googleIntegrationsTable } from "../db/schemas/google-integration.js";
import { ClassroomNotConnectedError } from "./classroom.errors.js";
import { TokenCipher } from "./token-cipher.js";

const GOOGLE = "https://www.googleapis.com/auth";

/** Scopes "Connect Classroom" asks for. Roster names only: no `classroom.profile.emails`. */
export const CLASSROOM_SCOPES = [
	`${GOOGLE}/classroom.courses.readonly`,
	`${GOOGLE}/classroom.rosters.readonly`,
	`${GOOGLE}/classroom.coursework.students`,
	`${GOOGLE}/drive.file`,
] as const;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const REQUEST_TIMEOUT_MS = 10_000;
/** An access token this close to expiring is refreshed instead of used. */
const EXPIRY_MARGIN_MS = 60_000;
/** Google access tokens last an hour; used when the response leaves it out. */
const DEFAULT_EXPIRES_IN_S = 3600;

export interface ClassroomConnectionStatus {
	connected: boolean;
	email: string | null;
	connectedAt: Date | null;
}

interface TokenResponse {
	access_token?: string;
	expires_in?: number;
	refresh_token?: string;
	error?: string;
}

/** Stores and refreshes the Google tokens of "Connect Classroom". */
@Injectable()
export class GoogleIntegrationService {
	private readonly logger = new Logger(GoogleIntegrationService.name);
	private readonly clientId: string;
	private readonly clientSecret: string;

	constructor(
		@InjectDrizzle() private readonly db: NodePgDatabase,
		private readonly cipher: TokenCipher,
		configService: ConfigService,
	) {
		this.clientId = configService.getOrThrow<string>("GOOGLE_CLIENT_ID");
		this.clientSecret = configService.getOrThrow<string>("GOOGLE_CLIENT_SECRET");
	}

	/**
	 * Saves the connection from the OIDC link callback, replacing any earlier
	 * one (and clearing a revocation). Refuses a consent that left a scope
	 * unchecked or came without a refresh token.
	 */
	async save(userId: string, profile: OidcProfile, tokens: OAuthTokens): Promise<void> {
		if (!tokens.refreshToken) {
			throw new BadRequestException("Google did not return a refresh token; connect again");
		}

		const granted = new Set((tokens.scope ?? "").split(" ").filter(Boolean));
		const missing = CLASSROOM_SCOPES.filter((scope) => !granted.has(scope));
		if (missing.length > 0) {
			throw new BadRequestException(
				"MISSING_SCOPES: allow every Google Classroom permission to connect",
			);
		}

		const values = {
			googleSubject: profile.subject,
			googleEmail: profile.email ?? null,
			refreshTokenEnc: this.cipher.encrypt(tokens.refreshToken),
			accessTokenEnc: this.cipher.encrypt(tokens.accessToken),
			accessTokenExpiresAt: expiresAt(tokens.expiresIn),
			scopes: [...granted].join(" "),
			revokedAt: null,
		};

		await this.db
			.insert(googleIntegrationsTable)
			.values({ userId, ...values })
			.onConflictDoUpdate({ target: googleIntegrationsTable.userId, set: values });
	}

	/**
	 * A valid access token for the user, refreshed when it is about to expire.
	 * Throws ClassroomNotConnectedError when there is no live connection or
	 * Google refused the refresh token (the connection is then marked revoked).
	 */
	async getAccessToken(userId: string): Promise<string> {
		const [row] = await this.db
			.select()
			.from(googleIntegrationsTable)
			.where(eq(googleIntegrationsTable.userId, userId))
			.limit(1);

		if (!row || row.revokedAt) throw new ClassroomNotConnectedError();

		if (
			row.accessTokenEnc &&
			row.accessTokenExpiresAt &&
			row.accessTokenExpiresAt.getTime() - Date.now() > EXPIRY_MARGIN_MS
		) {
			return this.cipher.decrypt(row.accessTokenEnc);
		}

		const refreshed = await this.refresh(userId, this.cipher.decrypt(row.refreshTokenEnc));

		await this.db
			.update(googleIntegrationsTable)
			.set({
				accessTokenEnc: this.cipher.encrypt(refreshed.access_token),
				accessTokenExpiresAt: expiresAt(refreshed.expires_in),
				// Google rarely rotates it, but when it does the old one stops working.
				...(refreshed.refresh_token && {
					refreshTokenEnc: this.cipher.encrypt(refreshed.refresh_token),
				}),
			})
			.where(eq(googleIntegrationsTable.userId, userId));

		return refreshed.access_token;
	}

	async status(userId: string): Promise<ClassroomConnectionStatus> {
		const [row] = await this.db
			.select({
				email: googleIntegrationsTable.googleEmail,
				createdAt: googleIntegrationsTable.createdAt,
				revokedAt: googleIntegrationsTable.revokedAt,
			})
			.from(googleIntegrationsTable)
			.where(eq(googleIntegrationsTable.userId, userId))
			.limit(1);

		if (!row) return { connected: false, email: null, connectedAt: null };
		return { connected: !row.revokedAt, email: row.email, connectedAt: row.createdAt };
	}

	async isConnected(userId: string): Promise<boolean> {
		return (await this.status(userId)).connected;
	}

	/**
	 * Revokes the token at Google (best effort: it may already be revoked) and
	 * deletes the connection. Returns false when there was nothing to remove.
	 */
	async disconnect(userId: string): Promise<boolean> {
		const [row] = await this.db
			.select({ refreshTokenEnc: googleIntegrationsTable.refreshTokenEnc })
			.from(googleIntegrationsTable)
			.where(eq(googleIntegrationsTable.userId, userId))
			.limit(1);

		if (!row) return false;

		try {
			const response = await fetch(REVOKE_URL, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ token: this.cipher.decrypt(row.refreshTokenEnc) }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!response.ok) {
				this.logger.warn(`Google revoke answered ${response.status} for user ${userId}`);
			}
		} catch (error) {
			this.logger.warn(
				`Google revoke failed for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		await this.db.delete(googleIntegrationsTable).where(eq(googleIntegrationsTable.userId, userId));
		return true;
	}

	private async refresh(
		userId: string,
		refreshToken: string,
	): Promise<TokenResponse & { access_token: string }> {
		let response: Response;
		try {
			response = await fetch(TOKEN_URL, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: this.clientId,
					client_secret: this.clientSecret,
					refresh_token: refreshToken,
					grant_type: "refresh_token",
				}),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			this.logger.error(
				`Google token refresh did not respond: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw new ServiceUnavailableException("Google is unavailable");
		}

		const payload = (await response.json().catch(() => ({}))) as TokenResponse;

		if (payload.error === "invalid_grant") {
			await this.db
				.update(googleIntegrationsTable)
				.set({ revokedAt: new Date(), accessTokenEnc: null, accessTokenExpiresAt: null })
				.where(eq(googleIntegrationsTable.userId, userId));
			this.logger.warn(`Google refused the refresh token of user ${userId}; marked revoked`);
			throw new ClassroomNotConnectedError("Google Classroom access was revoked");
		}

		if (!response.ok || !payload.access_token) {
			this.logger.error(
				`Google token refresh failed with ${response.status}: ${payload.error ?? "no error code"}`,
			);
			throw new BadGatewayException("Google token refresh failed");
		}

		return { ...payload, access_token: payload.access_token };
	}
}

function expiresAt(expiresIn: number | undefined): Date {
	return new Date(Date.now() + (expiresIn ?? DEFAULT_EXPIRES_IN_S) * 1000);
}
