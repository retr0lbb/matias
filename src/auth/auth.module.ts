import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { SharedModule } from '../shared/shared.module.js';
import { SessionAuth } from './providers/session-auth-provider.js';
import { EmailVerificationMailer } from './providers/email-verification.mailer.js';
import { EmailVerificationController } from './email-verification.controller.js';
import { MeController } from './me.controller.js';
import { OidcController } from './oidc.controller.js';
import { AccountLinker } from './providers/account-linker.js';

@Module({
  imports: [SharedModule],
  controllers: [AuthController, EmailVerificationController, MeController, OidcController],
  providers: [AuthService, SessionAuth, EmailVerificationMailer, AccountLinker],
})
export class AuthModule {}
