import { Module } from '@nestjs/common';
import { RouterModule } from './router/router.module.js';
import { AiModule } from './ai/ai.module.js';
import { RagModule } from './rag/rag.module.js';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { SharedModule } from './shared/shared.module.js';
import { DrizzleModule } from '@nestjs/drizzle';
import {drizzle} from "drizzle-orm/node-postgres"

@Module({
  imports: [
    RouterModule, 
    AiModule, 
    RagModule,
    DrizzleModule.forRoot({
      drizzle,
      connection: process.env.DATABASE_URL!
    }),
    ConfigModule.forRoot({
      isGlobal: true
    }),
    AuthModule,
    SharedModule,
  ]
})
export class AppModule {}
