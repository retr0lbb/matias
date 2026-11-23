import type { OAuthTokens, OidcProfile } from "@nestjs/authentication";
import {
	BadGatewayException,
	BadRequestException,
	Logger,
	ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getDrizzleToken } from "@nestjs/drizzle";
import { Test } from "@nestjs/testing";
import type { MockedFunction } from "vitest";
import type { GoogleIntegration } from "../db/schemas/google-integration.js";
import { ClassroomNotConnectedError } from "./classroom.errors.js";
import { CLASSROOM_SCOPES, GoogleIntegrationService } from "./google-integration.service.js";
import { TokenCipher } from "./token-cipher.js";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ALL_SCOPES = ["openid", ...CLASSROOM_SCOPES].join(" ");

/** Fake cipher: "enc(x)" in, "x" out, so tests can read what was stored. */
const createCipherMock = () => ({
	encrypt: vi.fn((plain: string) => `enc(${plain})`) as unknown as MockedFunction<
		TokenCipher["encrypt"]
	>,
	decrypt: vi.fn((value: string) => value.replace(/^enc\((.*)\)$/, "$1")) as unknown as MockedFunction<
		TokenCipher["decrypt"]
	>,
});

/** Fake Drizzle client with the select, insert, update and delete chains the service uses. */
const createDbMock = () => {
	const select = { from: vi.fn(), where: vi.fn(), limit: vi.fn<() => Promise<unknown[]>>() };
	select.from.mockReturnValue(select);
	select.where.mockReturnValue(select);
	select.limit.mockResolvedValue([]);

	const insert = {
		values: vi.fn<(values: Record<string, unknown>) => unknown>(),
		onConflictDoUpdate: vi.fn<(config: { set: Record<string, unknown> }) => Promise<void>>(),
	};
	insert.values.mockReturnValue(insert);
	insert.onConflictDoUpdate.mockResolvedValue(undefined);

	const update = {
		set: vi.fn<(values: Record<string, unknown>) => unknown>(),
		where: vi.fn<() => Promise<void>>(),
	};
	update.set.mockReturnValue(update);
	update.where.mockResolvedValue(undefined);

	const remove = { where: vi.fn<() => Promise<void>>() };
	remove.where.mockResolvedValue(undefined);

	return {
		select: vi.fn(() => select),
		insert: vi.fn(() => insert),
		update: vi.fn(() => update),
		delete: vi.fn(() => remove),
		chains: { select, insert, update, remove },
	};
};

const buildRow = (overrides: Partial<GoogleIntegration> = {}): GoogleIntegration => ({
	userId: USER_ID,
	googleSubject: "google-sub-1",
	googleEmail: "teacher@school.example",
	refreshTokenEnc: "enc(refresh-1)",
	accessTokenEnc: "enc(access-1)",
	accessTokenExpiresAt: new Date(NOW.getTime() + 30 * 60_000),
	scopes: ALL_SCOPES,
	createdAt: new Date("2026-11-01T00:00:00.000Z"),
	updatedAt: new Date("2026-11-01T00:00:00.000Z"),
	revokedAt: null,
	...overrides,
});

const buildProfile = (overrides: Partial<OidcProfile> = {}): OidcProfile => ({
	provider: "google-classroom",
	subject: "google-sub-1",
	email: "teacher@school.example",
	emailVerified: true,
	claims: {},
	...overrides,
});

const buildTokens = (overrides: Partial<OAuthTokens> = {}): OAuthTokens => ({
	accessToken: "access-1",
	refreshToken: "refresh-1",
	expiresIn: 3599,
	scope: ALL_SCOPES,
	...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("GoogleIntegrationService", () => {
	let service: GoogleIntegrationService;
	let db: ReturnType<typeof createDbMock>;
	let cipher: ReturnType<typeof createCipherMock>;
	let fetchMock: MockedFunction<typeof fetch>;

	/** Form body of the n-th fetch call. */
	const formOf = (call = 0) => {
		const body = fetchMock.mock.calls[call]?.[1]?.body;
		return Object.fromEntries(body instanceof URLSearchParams ? body : new URLSearchParams());
	};

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		db = createDbMock();
		cipher = createCipherMock();
		fetchMock = vi.fn() as unknown as MockedFunction<typeof fetch>;
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
		vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

		const config = {
			getOrThrow: vi.fn((key: string) => `${key}-value`) as unknown as MockedFunction<
				ConfigService["getOrThrow"]
			>,
		};

		const module = await Test.createTestingModule({
			providers: [
				GoogleIntegrationService,
				{ provide: getDrizzleToken(), useValue: db },
				{ provide: TokenCipher, useValue: cipher },
				{ provide: ConfigService, useValue: config },
			],
		}).compile();

		service = module.get(GoogleIntegrationService);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	describe("save", () => {
		it("should upsert the encrypted tokens when every scope was granted", async () => {
			await service.save(USER_ID, buildProfile(), buildTokens());

			const values = db.chains.insert.values.mock.calls[0]?.[0];
			expect(values).toEqual({
				userId: USER_ID,
				googleSubject: "google-sub-1",
				googleEmail: "teacher@school.example",
				refreshTokenEnc: "enc(refresh-1)",
				accessTokenEnc: "enc(access-1)",
				accessTokenExpiresAt: new Date(NOW.getTime() + 3599 * 1000),
				scopes: ALL_SCOPES,
				revokedAt: null,
			});
			const { userId: _userId, ...updatable } = values ?? {};
			expect(db.chains.insert.onConflictDoUpdate.mock.calls[0]?.[0].set).toEqual(updatable);
		});

		it("should store a null email when the profile has none", async () => {
			await service.save(USER_ID, buildProfile({ email: undefined }), buildTokens());

			expect(db.chains.insert.values.mock.calls[0]?.[0]).toMatchObject({ googleEmail: null });
		});

		it("should default the access token lifetime to an hour when expiresIn is missing", async () => {
			await service.save(USER_ID, buildProfile(), buildTokens({ expiresIn: undefined }));

			expect(db.chains.insert.values.mock.calls[0]?.[0]).toMatchObject({
				accessTokenExpiresAt: new Date(NOW.getTime() + 3600 * 1000),
			});
		});

		it("should throw BadRequestException when Google returned no refresh token", async () => {
			await expect(
				service.save(USER_ID, buildProfile(), buildTokens({ refreshToken: undefined })),
			).rejects.toThrow(BadRequestException);
			expect(db.insert).not.toHaveBeenCalled();
		});

		it.each([
			["one scope is missing", ALL_SCOPES.replace(CLASSROOM_SCOPES[3], "")],
			["the scope is empty", ""],
			["the scope is undefined", undefined],
		])("should throw MISSING_SCOPES when %s", async (_label, scope) => {
			await expect(service.save(USER_ID, buildProfile(), buildTokens({ scope }))).rejects.toThrow(
				"MISSING_SCOPES",
			);
			expect(db.insert).not.toHaveBeenCalled();
		});
	});

	describe("getAccessToken", () => {
		it("should throw ClassroomNotConnectedError when there is no connection", async () => {
			await expect(service.getAccessToken(USER_ID)).rejects.toThrow(ClassroomNotConnectedError);
		});

		it("should throw ClassroomNotConnectedError when the connection was revoked", async () => {
			db.chains.select.limit.mockResolvedValue([buildRow({ revokedAt: NOW })]);

			await expect(service.getAccessToken(USER_ID)).rejects.toThrow(ClassroomNotConnectedError);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("should return the cached token when it has more than a minute left", async () => {
			db.chains.select.limit.mockResolvedValue([buildRow()]);

			await expect(service.getAccessToken(USER_ID)).resolves.toBe("access-1");
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it.each([
			["expires within the margin", { accessTokenExpiresAt: new Date(NOW.getTime() + 60_000) }],
			["already expired", { accessTokenExpiresAt: new Date(NOW.getTime() - 1) }],
			["has no expiry", { accessTokenExpiresAt: null }],
			["is not cached", { accessTokenEnc: null }],
		])("should refresh the token when the cached one %s", async (_label, overrides) => {
			db.chains.select.limit.mockResolvedValue([buildRow(overrides)]);
			fetchMock.mockResolvedValue(jsonResponse({ access_token: "access-2", expires_in: 1800 }));

			const token = await service.getAccessToken(USER_ID);

			expect(token).toBe("access-2");
			expect(fetchMock.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
			expect(formOf()).toEqual({
				client_id: "GOOGLE_CLIENT_ID-value",
				client_secret: "GOOGLE_CLIENT_SECRET-value",
				refresh_token: "refresh-1",
				grant_type: "refresh_token",
			});
			expect(db.chains.update.set).toHaveBeenCalledWith({
				accessTokenEnc: "enc(access-2)",
				accessTokenExpiresAt: new Date(NOW.getTime() + 1800 * 1000),
			});
		});

		it("should store a rotated refresh token when Google returns one", async () => {
			db.chains.select.limit.mockResolvedValue([buildRow({ accessTokenEnc: null })]);
			fetchMock.mockResolvedValue(
				jsonResponse({ access_token: "access-2", expires_in: 1800, refresh_token: "refresh-2" }),
			);

			await service.getAccessToken(USER_ID);

			expect(db.chains.update.set).toHaveBeenCalledWith(
				expect.objectContaining({ refreshTokenEnc: "enc(refresh-2)" }),
			);
		});

		it("should mark the connection revoked when Google answers invalid_grant", async () => {
			db.chains.select.limit.mockResolvedValue([buildRow({ accessTokenEnc: null })]);
			fetchMock.mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));

			await expect(service.getAccessToken(USER_ID)).rejects.toThrow(ClassroomNotConnectedError);
			expect(db.chains.update.set).toHaveBeenCalledWith({
				revokedAt: NOW,
				accessTokenEnc: null,
				accessTokenExpiresAt: null,
			});
		});

		it.each([
			["Google answers 500", () => jsonResponse({ error: "internal" }, 500)],
			["the body is not JSON", () => new Response("<html>", { status: 502 })],
			["the 200 body has no access token", () => jsonResponse({ expires_in: 3600 })],
		])("should throw BadGatewayException when %s", async (_label, response) => {
			db.chains.select.limit.mockResolvedValue([buildRow({ accessTokenEnc: null })]);
			fetchMock.mockResolvedValue(response());

			await expect(service.getAccessToken(USER_ID)).rejects.toThrow(BadGatewayException);
			expect(db.update).not.toHaveBeenCalled();
		});

		it("should throw ServiceUnavailableException when Google does not respond", async () => {
			db.chains.select.limit.mockResolvedValue([buildRow({ accessTokenEnc: null })]);
			fetchMock.mockRejectedValue(new TypeError("fetch failed"));

			await expect(service.getAccessToken(USER_ID)).rejects.toThrow(ServiceUnavailableException);
		});
	});

	describe("status", () => {
		it("should report not connected when there is no connection", async () => {
			await expect(service.status(USER_ID)).resolves.toEqual({
				connected: false,
				email: null,
				connectedAt: null,
			});
		});

		it("should report connected with the email when the connection is live", async () => {
			const createdAt = new Date("2026-11-01T00:00:00.000Z");
			db.chains.select.limit.mockResolvedValue([
				{ email: "teacher@school.example", createdAt, revokedAt: null },
			]);

			await expect(service.status(USER_ID)).resolves.toEqual({
				connected: true,
				email: "teacher@school.example",
				connectedAt: createdAt,
			});
		});

		it("should report not connected when the connection was revoked", async () => {
			db.chains.select.limit.mockResolvedValue([
				{ email: "teacher@school.example", createdAt: NOW, revokedAt: NOW },
			]);

			await expect(service.status(USER_ID)).resolves.toMatchObject({ connected: false });
		});
	});

	describe("isConnected", () => {
		it.each([
			[[], false],
			[[{ email: null, createdAt: NOW, revokedAt: null }], true],
		])("should follow the status when the rows are %j", async (rows, expected) => {
			db.chains.select.limit.mockResolvedValue(rows);

			await expect(service.isConnected(USER_ID)).resolves.toBe(expected);
		});
	});

	describe("disconnect", () => {
		it("should return false when there is nothing to disconnect", async () => {
			await expect(service.disconnect(USER_ID)).resolves.toBe(false);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(db.delete).not.toHaveBeenCalled();
		});

		it("should revoke the refresh token and delete the connection", async () => {
			db.chains.select.limit.mockResolvedValue([{ refreshTokenEnc: "enc(refresh-1)" }]);
			fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

			await expect(service.disconnect(USER_ID)).resolves.toBe(true);
			expect(fetchMock.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/revoke");
			expect(formOf()).toEqual({ token: "refresh-1" });
			expect(db.delete).toHaveBeenCalledTimes(1);
		});

		it.each([
			["Google answers 400", () => fetchMock.mockResolvedValue(new Response(null, { status: 400 }))],
			["Google does not respond", () => fetchMock.mockRejectedValue(new TypeError("fetch failed"))],
			["Google rejects with a non-Error", () => fetchMock.mockRejectedValue("boom")],
		])("should still delete the connection when %s", async (_label, arrange) => {
			db.chains.select.limit.mockResolvedValue([{ refreshTokenEnc: "enc(refresh-1)" }]);
			arrange();

			await expect(service.disconnect(USER_ID)).resolves.toBe(true);
			expect(db.delete).toHaveBeenCalledTimes(1);
		});
	});
});
