import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DrizzleModule } from '@nestjs/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
//local
import { RouterModule } from './router/router.module.js';
import { AiModule } from './ai/ai.module.js';
import { RagModule } from './rag/rag.module.js';
import { AuthModule } from './auth/auth.module.js';
import { SharedModule } from './shared/shared.module.js';
import { AuthenticationModule, google } from '@nestjs/authentication';
import { FileTemplateEngine, LogMailTransport, MailModule, SmtpTransport } from '@nestjs/mail';
import { join } from 'node:path';
import { DocumentsModule } from './documents/documents.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MailModule.forRootAsync({
      useFactory: () => ({
        transport: process.env.SMTP_URL ? new SmtpTransport({ url: process.env.SMTP_URL }) : new LogMailTransport(),
        templates: new FileTemplateEngine({ dir: join(import.meta.dirname, 'mail/templates') }),
        from: 'Accounts <accounts@example.com>',
      })
    }),
    DrizzleModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        drizzle,
        connection: configService.getOrThrow<string>('DATABASE_URL'),
      }),
    }),
    AuthenticationModule.forRoot({
      session: {
        absoluteTtl: "14d",
        idleTtl: "4d"
      },
      emailVerification: {url: `${process.env.APP_URL}/verify-email`},
      oidc: {
        callbackUrl: `${process.env.GOOGLE_REDIRECT_URL}`,
        providers: {
          google: google({
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!
          })
        }
      }
    }),
    RouterModule,
    AiModule,
    RagModule,
    AuthModule,
    SharedModule,
    DocumentsModule,
  ],
})
export class AppModule {}