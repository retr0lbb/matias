import { join } from "node:path";
import { AuthenticationModule, google } from "@nestjs/authentication";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DrizzleModule } from "@nestjs/drizzle";
import { FileTemplateEngine, LogMailTransport, MailModule, ResendTransport } from "@nestjs/mail";
import { ScheduleModule } from "@nestjs/schedule";
import { drizzle } from "drizzle-orm/node-postgres";
import { AiModule } from "./ai/ai.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { ClassroomModule } from "./classroom/classroom.module.js";
import { CLASSROOM_SCOPES } from "./classroom/google-integration.service.js";
import { DocumentsModule } from "./documents/documents.module.js";
import { PaymentModule } from "./payment/payment.module.js";
import { RagModule } from "./rag/rag.module.js";
import { OlafModule } from "./shared/crons/cont_olaf/olaf.module.js";
import { BeliargeModule } from "./shared/crons/mr_beliarge/beliarge.module.js";
import { SharedModule } from "./shared/shared.module.js";
import { SubscriptionModule } from "./subscription/subscription.module.js";
import { UsageModule } from "./usage/usage.module.js";

/**
 * The OIDC callback URL with `:provider` in it, which the library replaces by
 * each provider's name. An older `GOOGLE_REDIRECT_URL` that names `google`
 * literally is turned into the template, so existing envs keep working.
 */
function oidcCallbackUrl(configured: string): string {
	return configured.includes(":provider")
		? configured
		: configured.replace(/\/google\/callback(?=\/?$)/, "/:provider/callback");
}

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
		}),
		ScheduleModule.forRoot(),
		MailModule.forRootAsync({
			useFactory: () => ({
				transport: process.env.RESEND_API_KEY
					? new ResendTransport({ apiKey: process.env.RESEND_API_KEY!, timeout: 10_000 })
					: new LogMailTransport(),
				templates: new FileTemplateEngine({ dir: join(import.meta.dirname, "mail/templates") }),
				from: `Contato <${process.env.EMAIL_DOMAIN}>`,
			}),
		}),
		DrizzleModule.forRootAsync({
			inject: [ConfigService],
			useFactory: (configService: ConfigService) => ({
				drizzle,
				connection: configService.getOrThrow<string>("DATABASE_URL"),
			}),
		}),
		AuthenticationModule.forRoot({
			session: {
				absoluteTtl: "14d",
				idleTtl: "4d",
			},
			emailVerification: { url: `${process.env.EMAIL_FRONTEND_URL_REDIRECT}/verify-email` },
			oidc: {
				callbackUrl: oidcCallbackUrl(process.env.GOOGLE_REDIRECT_URL ?? ""),
				redirectAfterLogin: process.env.APP_URL ?? "/me",
				providers: {
					google: google({
						clientId: process.env.GOOGLE_CLIENT_ID!,
						clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
					}),
					// "Connect Classroom": link-only (see AccountLinker), offline access for the tools.
					"google-classroom": {
						...google({
							clientId: process.env.GOOGLE_CLIENT_ID!,
							clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
						}),
						scopes: ["openid", "email", "profile", ...CLASSROOM_SCOPES],
						authorizationParams: {
							access_type: "offline",
							prompt: "consent",
							include_granted_scopes: "true",
						},
					},
				},
			},
		}),
		AiModule,
		RagModule,
		AuthModule,
		SharedModule,
		DocumentsModule,
		UsageModule,
		SubscriptionModule,
		PaymentModule,
		ClassroomModule,
		BeliargeModule,
		OlafModule,
	],
})
export class AppModule {}
