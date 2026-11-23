import {
	AuthenticationRegistry,
	type OAuthTokens,
	type OidcProfile,
} from "@nestjs/authentication";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MockedFunction } from "vitest";
import { GoogleIntegrationService } from "../../classroom/google-integration.service.js";
import type { User } from "../../db/schemas/user.js";
import { AuthService } from "../auth.service.js";
import { AccountLinker } from "./account-linker.js";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const createAuthServiceMock = () => ({
	findByGoogleSubject: vi.fn() as unknown as MockedFunction<AuthService["findByGoogleSubject"]>,
	findByEmail: vi.fn() as unknown as MockedFunction<AuthService["findByEmail"]>,
	createGoogleUser: vi.fn() as unknown as MockedFunction<AuthService["createGoogleUser"]>,
});

const createIntegrationMock = () => ({
	save: vi.fn() as unknown as MockedFunction<GoogleIntegrationService["save"]>,
});

const createRegistryMock = () => ({
	registerHandler: vi.fn() as unknown as MockedFunction<AuthenticationRegistry["registerHandler"]>,
});

const buildProfile = (overrides: Partial<OidcProfile> = {}): OidcProfile => ({
	provider: "google",
	subject: "google-sub-1",
	email: "teacher@example.com",
	emailVerified: true,
	name: "Teacher",
	claims: {},
	...overrides,
});

const TOKENS: OAuthTokens = { accessToken: "access", refreshToken: "refresh", scope: "openid" };

const buildUser = (overrides: Partial<User> = {}) =>
	({ id: USER_ID, loginProvider: "GOOGLE", ...overrides }) as User;

describe("AccountLinker", () => {
	let linker: AccountLinker;
	let auth: ReturnType<typeof createAuthServiceMock>;
	let integration: ReturnType<typeof createIntegrationMock>;
	let registry: ReturnType<typeof createRegistryMock>;

	beforeEach(async () => {
		auth = createAuthServiceMock();
		integration = createIntegrationMock();
		registry = createRegistryMock();

		const module = await Test.createTestingModule({
			providers: [
				AccountLinker,
				{ provide: AuthService, useValue: auth },
				{ provide: GoogleIntegrationService, useValue: integration },
				{ provide: AuthenticationRegistry, useValue: registry },
			],
		}).compile();

		linker = module.get(AccountLinker);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("should register itself as the oidc handler", () => {
		expect(registry.registerHandler).toHaveBeenCalledWith("oidc", linker);
	});

	describe("resolveUser", () => {
		describe("google-classroom", () => {
			const classroomProfile = buildProfile({ provider: "google-classroom" });

			it("should save the integration and keep the signed-in user when linking", async () => {
				integration.save.mockResolvedValue(undefined);

				const result = await linker.resolveUser(classroomProfile, TOKENS, {
					linkTo: { id: USER_ID },
				});

				expect(result).toEqual({ id: USER_ID });
				expect(integration.save).toHaveBeenCalledWith(USER_ID, classroomProfile, TOKENS);
				expect(auth.findByGoogleSubject).not.toHaveBeenCalled();
			});

			it("should refuse to sign in when the flow is not a link", async () => {
				await expect(linker.resolveUser(classroomProfile, TOKENS, {})).rejects.toThrow(
					ForbiddenException,
				);
				expect(integration.save).not.toHaveBeenCalled();
			});

			it("should connect even when the Google email is not verified", async () => {
				integration.save.mockResolvedValue(undefined);

				await expect(
					linker.resolveUser(
						buildProfile({ provider: "google-classroom", emailVerified: false, email: undefined }),
						TOKENS,
						{ linkTo: { id: USER_ID } },
					),
				).resolves.toEqual({ id: USER_ID });
			});

			it("should propagate the error when saving the integration fails", async () => {
				integration.save.mockRejectedValue(new BadRequestException("MISSING_SCOPES"));

				await expect(
					linker.resolveUser(classroomProfile, TOKENS, { linkTo: { id: USER_ID } }),
				).rejects.toThrow("MISSING_SCOPES");
			});
		});

		describe("google", () => {
			it.each([
				["has no email", { email: undefined }],
				["has an unverified email", { emailVerified: false }],
			])("should throw ForbiddenException when the profile %s", async (_label, overrides) => {
				await expect(linker.resolveUser(buildProfile(overrides), TOKENS, {})).rejects.toThrow(
					ForbiddenException,
				);
			});

			it("should return the existing Google user when the subject is known", async () => {
				const user = buildUser();
				auth.findByGoogleSubject.mockResolvedValue(user);

				await expect(linker.resolveUser(buildProfile(), TOKENS, {})).resolves.toBe(user);
				expect(auth.findByGoogleSubject).toHaveBeenCalledWith("google-sub-1");
				expect(integration.save).not.toHaveBeenCalled();
			});

			it("should throw ConflictException when the subject belongs to a LOCAL user", async () => {
				auth.findByGoogleSubject.mockResolvedValue(buildUser({ loginProvider: "LOCAL" }));

				await expect(linker.resolveUser(buildProfile(), TOKENS, {})).rejects.toThrow(
					ConflictException,
				);
			});

			it("should throw ConflictException when another account has the email", async () => {
				auth.findByGoogleSubject.mockResolvedValue(undefined as never);
				auth.findByEmail.mockResolvedValue(buildUser({ loginProvider: "LOCAL" }) as never);

				await expect(linker.resolveUser(buildProfile(), TOKENS, {})).rejects.toThrow(
					ConflictException,
				);
				expect(auth.createGoogleUser).not.toHaveBeenCalled();
			});

			it.each([
				["the profile name", { name: "Teacher" }, "Teacher"],
				["the email when there is no name", { name: undefined }, "teacher@example.com"],
			])("should create a Google user named with %s", async (_label, overrides, name) => {
				const created = buildUser();
				auth.findByGoogleSubject.mockResolvedValue(undefined as never);
				auth.findByEmail.mockResolvedValue(undefined as never);
				auth.createGoogleUser.mockResolvedValue(created as never);

				await expect(linker.resolveUser(buildProfile(overrides), TOKENS, {})).resolves.toBe(created);
				expect(auth.createGoogleUser).toHaveBeenCalledWith({
					name,
					email: "teacher@example.com",
					subject: "google-sub-1",
				});
			});
		});
	});
});
