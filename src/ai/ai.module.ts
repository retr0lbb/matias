import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { AiExpensesFactory } from './ai.factory.js';
import { RagModule } from '../rag/rag.module.js';

@Module({
  imports: [ConfigModule, RagModule],
  controllers: [AiController],
  providers: [AiService, AiExpensesFactory],
  exports: [AiService, AiExpensesFactory],
})
export class AiModule {}
