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
import { DocumentsModule } from "./documents/documents.module.js";
import { PaymentModule } from "./payment/payment.module.js";
import { RagModule } from "./rag/rag.module.js";
import { RouterModule } from "./router/router.module.js";
import { OlafModule } from "./shared/crons/cont_olaf/olaf.module.js";
import { BeliargeModule } from "./shared/crons/mr_beliarge/beliarge.module.js";
import { SharedModule } from "./shared/shared.module.js";
import { SubscriptionModule } from "./subscription/subscription.module.js";
import { UsageModule } from "./usage/usage.module.js";

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
				callbackUrl: `${process.env.GOOGLE_REDIRECT_URL}`,
				redirectAfterLogin: process.env.APP_URL ?? "/me",
				providers: {
					google: google({
						clientId: process.env.GOOGLE_CLIENT_ID!,
						clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
					}),
				},
			},
		}),
		RouterModule,
		AiModule,
		RagModule,
		AuthModule,
		SharedModule,
		DocumentsModule,
		UsageModule,
		SubscriptionModule,
		PaymentModule,
		BeliargeModule,
		OlafModule,
	],
})
export class AppModule {}
