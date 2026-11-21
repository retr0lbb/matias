import { Module } from "@nestjs/common";
import { SharedModule } from "../shared/shared.module.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { EmailVerificationController } from "./email-verification.controller.js";
import { MeController } from "./me.controller.js";
import { OidcController } from "./oidc.controller.js";
import { AccountLinker } from "./providers/account-linker.js";
import { DrizzleAuthStore } from "./providers/drizzle-auth.store.js";
import { EmailVerificationMailer } from "./providers/email-verification.mailer.js";
import { SessionAuth } from "./providers/session-auth-provider.js";

@Module({
	imports: [SharedModule],
	controllers: [AuthController, EmailVerificationController, MeController, OidcController],
	providers: [AuthService, SessionAuth, EmailVerificationMailer, AccountLinker, DrizzleAuthStore],
})
export class AuthModule {}
