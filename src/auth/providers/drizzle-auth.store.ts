import {
	AuthenticationStorage,
	type EmailTokenPurpose,
	type EmailTokenRecord,
	type EmailTokenStore,
	type OidcStateStore,
	type OidcTransaction,
	type SessionRecord,
	type SessionStore,
} from "@nestjs/authentication";
import { Injectable } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, eq, lt, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
	type AuthEmailTokenRow,
	type AuthOidcStateRow,
	type AuthSessionRow,
	authEmailTokensTable,
	authOidcStatesTable,
	authSessionsTable,
} from "../../db/schemas/auth.js";

// Nullable columns come back as missing fields, never `null`, like the
// library's in-memory records.

function toSession(row: AuthSessionRow): SessionRecord {
	return {
		id: row.id,
		userId: row.userId,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		lastActiveAt: row.lastActiveAt,
		...(row.mfa !== null && { mfa: row.mfa }),
		...(row.metadata !== null && { metadata: row.metadata }),
	};
}

function toOidcTransaction(row: AuthOidcStateRow): OidcTransaction {
	return {
		state: row.state,
		provider: row.provider,
		codeVerifier: row.codeVerifier,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		...(row.nonce !== null && { nonce: row.nonce }),
		...(row.redirectTo !== null && { redirectTo: row.redirectTo }),
		...(row.link !== null && { link: row.link }),
	};
}

function toEmailToken(row: AuthEmailTokenRow): EmailTokenRecord {
	return {
		id: row.id,
		purpose: row.purpose,
		userId: row.userId,
		email: row.email,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		...(row.fingerprint !== null && { fingerprint: row.fingerprint }),
	};
}

/**
 * Postgres storage for the authentication module's state: sessions, Google
 * logins in progress and email links. Without it they live in process memory.
 * Expired rows are deleted whenever a new row of the same kind is written.
 * See specs/auth-storage.md.
 */
@Injectable()
export class DrizzleAuthStore implements SessionStore, OidcStateStore, EmailTokenStore {
	constructor(
		@InjectDrizzle() private readonly db: NodePgDatabase,
		storage: AuthenticationStorage,
	) {
		storage.registerSource({ sessions: this, oidcStates: this, emailTokens: this });
	}

	// Sessions

	async getSession(id: string): Promise<SessionRecord | undefined> {
		const [row] = await this.db
			.select()
			.from(authSessionsTable)
			.where(eq(authSessionsTable.id, id));
		return row && toSession(row);
	}

	async createSession(record: SessionRecord): Promise<void> {
		await this.db
			.delete(authSessionsTable)
			.where(lte(authSessionsTable.expiresAt, record.lastActiveAt));
		// `extra` is read along with a session, never stored.
		await this.db.insert(authSessionsTable).values({
			id: record.id,
			userId: record.userId,
			createdAt: record.createdAt,
			expiresAt: record.expiresAt,
			lastActiveAt: record.lastActiveAt,
			mfa: record.mfa ?? null,
			metadata: record.metadata ?? null,
		});
	}

	async touchSession(id: string, lastActiveAt: Date): Promise<void> {
		// Only forward: a slower concurrent request must not move it back.
		await this.db
			.update(authSessionsTable)
			.set({ lastActiveAt })
			.where(and(eq(authSessionsTable.id, id), lt(authSessionsTable.lastActiveAt, lastActiveAt)));
	}

	async deleteSession(id: string): Promise<boolean> {
		const deleted = await this.db
			.delete(authSessionsTable)
			.where(eq(authSessionsTable.id, id))
			.returning({ id: authSessionsTable.id });
		return deleted.length > 0;
	}

	async listUserSessions(userId: string): Promise<SessionRecord[]> {
		const rows = await this.db
			.select()
			.from(authSessionsTable)
			.where(eq(authSessionsTable.userId, userId));
		return rows.map(toSession);
	}

	async deleteUserSessions(userId: string): Promise<void> {
		await this.db.delete(authSessionsTable).where(eq(authSessionsTable.userId, userId));
	}

	// OIDC logins in progress

	async saveOidcState(transaction: OidcTransaction): Promise<void> {
		await this.db
			.delete(authOidcStatesTable)
			.where(lte(authOidcStatesTable.expiresAt, transaction.createdAt));
		await this.db.insert(authOidcStatesTable).values({
			state: transaction.state,
			provider: transaction.provider,
			codeVerifier: transaction.codeVerifier,
			nonce: transaction.nonce ?? null,
			redirectTo: transaction.redirectTo ?? null,
			link: transaction.link ?? null,
			createdAt: transaction.createdAt,
			expiresAt: transaction.expiresAt,
		});
	}

	async consumeOidcState(state: string): Promise<OidcTransaction | undefined> {
		// Read and delete in one statement: a login finishes at most once.
		const [row] = await this.db
			.delete(authOidcStatesTable)
			.where(eq(authOidcStatesTable.state, state))
			.returning();
		return row && toOidcTransaction(row);
	}

	// Email links

	async saveEmailToken(record: EmailTokenRecord): Promise<void> {
		await this.db
			.delete(authEmailTokensTable)
			.where(lte(authEmailTokensTable.expiresAt, record.createdAt));
		await this.db.insert(authEmailTokensTable).values({
			id: record.id,
			purpose: record.purpose,
			userId: record.userId,
			email: record.email,
			fingerprint: record.fingerprint ?? null,
			createdAt: record.createdAt,
			expiresAt: record.expiresAt,
		});
	}

	async consumeEmailToken(
		id: string,
		purpose: EmailTokenPurpose,
	): Promise<EmailTokenRecord | undefined> {
		// A token of another purpose is neither returned nor deleted.
		const [row] = await this.db
			.delete(authEmailTokensTable)
			.where(and(eq(authEmailTokensTable.id, id), eq(authEmailTokensTable.purpose, purpose)))
			.returning();
		return row && toEmailToken(row);
	}

	async deleteUserEmailTokens(userId: string, purpose: EmailTokenPurpose): Promise<void> {
		await this.db
			.delete(authEmailTokensTable)
			.where(
				and(eq(authEmailTokensTable.userId, userId), eq(authEmailTokensTable.purpose, purpose)),
			);
	}
}
