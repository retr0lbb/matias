import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CredentialService } from '../shared/services/credentials.js';
import { AuthenticationModule } from '@nestjs/authentication';

@Module({
  controllers: [AuthController],
  providers: [AuthService, CredentialService],
})
export class AuthModule {}
