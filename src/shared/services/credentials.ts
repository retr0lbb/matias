import { Inject, Injectable } from "@nestjs/common";
import { PasswordHasher } from "@nestjs/authentication"

@Injectable()
export class CredentialService{
    constructor(
        private readonly passwordHasher: PasswordHasher
    ){}

    async hashPassword(pass: string){
        return this.passwordHasher.hash(pass)
    }

    async comparePassword(pass: string, other: string){
        return this.passwordHasher.verify(pass, other)
    }
}