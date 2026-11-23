import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const VERSION = "v1";

/**
 * Encrypts Google tokens at rest with AES-256-GCM. The key is
 * `GOOGLE_TOKEN_ENC_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`).
 * Output: `v1:<iv>:<tag>:<ciphertext>`, each part base64.
 */
@Injectable()
export class TokenCipher {
	private readonly key: Buffer;

	constructor(configService: ConfigService) {
		const key = Buffer.from(configService.getOrThrow<string>("GOOGLE_TOKEN_ENC_KEY"), "base64");
		if (key.length !== 32) {
			throw new Error("GOOGLE_TOKEN_ENC_KEY must be 32 bytes, base64 encoded");
		}
		this.key = key;
	}

	encrypt(plain: string): string {
		const iv = randomBytes(IV_BYTES);
		const cipher = createCipheriv(ALGORITHM, this.key, iv);
		const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
		const tag = cipher.getAuthTag();

		return [VERSION, ...[iv, tag, ciphertext].map((part) => part.toString("base64"))].join(":");
	}

	/** Throws when the value was not produced with this key or was tampered with. */
	decrypt(encoded: string): string {
		const [version, iv, tag, ciphertext] = encoded.split(":");
		// The ciphertext of an empty string is empty, so only its absence is malformed.
		if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
			throw new Error("Malformed encrypted token");
		}

		const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, "base64"));
		decipher.setAuthTag(Buffer.from(tag, "base64"));

		return Buffer.concat([
			decipher.update(Buffer.from(ciphertext, "base64")),
			decipher.final(),
		]).toString("utf8");
	}
}
