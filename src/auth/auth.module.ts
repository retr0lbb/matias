import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { SharedModule } from '../shared/shared.module.js';
import { SessionAuth } from './providers/session-auth-provider.js';
import { EmailVerificationMailer } from './providers/email-verification.mailer.js';
import { EmailVerificationController } from './email-verification.controller.js';

@Module({
  imports: [SharedModule],
  controllers: [AuthController, EmailVerificationController],
  providers: [AuthService, SessionAuth, EmailVerificationMailer],
})
export class AuthModule {}
