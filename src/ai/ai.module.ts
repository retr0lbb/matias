import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { AiExpensesFactory } from './ai.factory.js';

@Module({
  imports: [ConfigModule],
  controllers: [AiController],
  providers: [AiService, AiExpensesFactory],
  exports: [AiService, AiExpensesFactory],
})
export class AiModule {}
