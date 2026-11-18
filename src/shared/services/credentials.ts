import { PasswordHasher } from "@nestjs/authentication";
import { Injectable } from "@nestjs/common";

@Injectable()
export class CredentialService {
	constructor(private readonly passwordHasher: PasswordHasher) {}

	async hashPassword(pass: string) {
		return this.passwordHasher.hash(pass);
	}

	async comparePassword(pass: string, other: string) {
		return this.passwordHasher.verify(pass, other);
	}
}
