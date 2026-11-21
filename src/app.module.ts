import { join } from "node:path";
import { AuthenticationModule, google } from "@nestjs/authentication";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DrizzleModule } from "@nestjs/drizzle";
import { FileTemplateEngine, LogMailTransport, MailModule, SmtpTransport } from "@nestjs/mail";
import { drizzle } from "drizzle-orm/node-postgres";
import { AiModule } from "./ai/ai.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { DocumentsModule } from "./documents/documents.module.js";
import { PaymentModule } from "./payment/payment.module.js";
import { RagModule } from "./rag/rag.module.js";
//local
import { RouterModule } from "./router/router.module.js";
import { SharedModule } from "./shared/shared.module.js";
import { SubscriptionModule } from "./subscription/subscription.module.js";
import { UsageModule } from "./usage/usage.module.js";

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
		}),
		MailModule.forRootAsync({
			useFactory: () => ({
				transport: process.env.SMTP_URL
					? new SmtpTransport({ url: process.env.SMTP_URL })
					: new LogMailTransport(),
				templates: new FileTemplateEngine({ dir: join(import.meta.dirname, "mail/templates") }),
				from: "Accounts <accounts@example.com>",
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
			emailVerification: { url: `${process.env.APP_URL}/verify-email` },
			oidc: {
				callbackUrl: `${process.env.GOOGLE_REDIRECT_URL}`,
				// Where the browser lands after Google when the login had no `redirectTo`
				// (the library default is `/` on this API, which has no route).
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
	],
})
export class AppModule {}
