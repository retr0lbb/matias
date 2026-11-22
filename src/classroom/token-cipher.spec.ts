import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import type { MockedFunction } from "vitest";
import { TokenCipher } from "./token-cipher.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

const buildCipher = async (key: string) => {
	const config = {
		getOrThrow: vi.fn(() => key) as unknown as MockedFunction<ConfigService["getOrThrow"]>,
	};
	const module = await Test.createTestingModule({
		providers: [TokenCipher, { provide: ConfigService, useValue: config }],
	}).compile();
	return module.get(TokenCipher);
};

describe("TokenCipher", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("constructor", () => {
		it.each([
			["shorter than 32 bytes", Buffer.alloc(16).toString("base64")],
			["longer than 32 bytes", Buffer.alloc(33).toString("base64")],
			["empty", ""],
		])("should throw when the key is %s", async (_label, key) => {
			await expect(buildCipher(key)).rejects.toThrow("GOOGLE_TOKEN_ENC_KEY must be 32 bytes");
		});
	});

	describe("encrypt", () => {
		it("should not contain the plain text when encrypting", async () => {
			const cipher = await buildCipher(KEY);

			const encrypted = cipher.encrypt("1//refresh-token-secret");

			expect(encrypted).not.toContain("refresh-token-secret");
			expect(encrypted.split(":")).toHaveLength(4);
			expect(encrypted.startsWith("v1:")).toBe(true);
		});

		it("should produce a different value each time when encrypting the same text", async () => {
			const cipher = await buildCipher(KEY);

			expect(cipher.encrypt("same")).not.toBe(cipher.encrypt("same"));
		});
	});

	describe("decrypt", () => {
		it.each(["1//refresh-token", "", "ação é ✓"])(
			"should return the original text when decrypting %j",
			async (plain) => {
				const cipher = await buildCipher(KEY);

				expect(cipher.decrypt(cipher.encrypt(plain))).toBe(plain);
			},
		);

		it("should throw when the ciphertext was tampered with", async () => {
			const cipher = await buildCipher(KEY);
			const [version, iv, tag, ciphertext] = cipher.encrypt("secret").split(":");
			const flipped = Buffer.from(ciphertext ?? "", "base64");
			flipped[0] = (flipped[0] ?? 0) ^ 1;

			expect(() =>
				cipher.decrypt([version, iv, tag, flipped.toString("base64")].join(":")),
			).toThrow();
		});

		it("should throw when the value was encrypted with another key", async () => {
			const encrypted = (await buildCipher(OTHER_KEY)).encrypt("secret");
			const cipher = await buildCipher(KEY);

			expect(() => cipher.decrypt(encrypted)).toThrow();
		});

		it.each([
			["an unknown version", "v2:aa:bb:cc"],
			["missing parts", "v1:aa:bb"],
			["an empty string", ""],
		])("should throw when the value has %s", async (_label, value) => {
			const cipher = await buildCipher(KEY);

			expect(() => cipher.decrypt(value)).toThrow("Malformed encrypted token");
		});
	});
});
