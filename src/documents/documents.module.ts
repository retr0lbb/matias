import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GeminiModule } from '../ai/gemini.client.js';
import { UsageModule } from '../usage/usage.module.js';
import { AssessmentAiService } from './ai/document-ai.service.js';
import { AssessmentsController } from './documents.controller.js';
import { AssessmentsService } from './documents.service.js';
import { PdfRendererService } from './pdf/pdf-renderer.service.js';

@Module({
  imports: [ConfigModule, GeminiModule, UsageModule],
  controllers: [AssessmentsController],
  providers: [AssessmentsService, AssessmentAiService, PdfRendererService],
  exports: [PdfRendererService, AssessmentsService],
})
export class DocumentsModule {}
