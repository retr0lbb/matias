import { Module } from '@nestjs/common';
import { CredentialService } from './services/credentials.js';
import { PasswordHasher } from '@nestjs/authentication';

@Module({
    imports: [],
    providers: [CredentialService, PasswordHasher],
    exports: [CredentialService]
})
export class SharedModule {}
