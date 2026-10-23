import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { SharedModule } from '../shared/shared.module.js';
import { SessionAuth } from './providers/session-auth-provider.js';

@Module({
  imports: [SharedModule],
  controllers: [AuthController],
  providers: [AuthService, SessionAuth],
})
export class AuthModule {}
