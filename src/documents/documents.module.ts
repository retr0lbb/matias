import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UsageModule } from '../usage/usage.module.js';
import { AssessmentAiService } from './assessment/ai/assessment-ai.service.js';
import { AssessmentsController } from './assessment/assessments.controller.js';
import { AssessmentsService } from './assessment/assessments.service.js';
import { PdfRendererService } from './assessment/pdf/pdf-renderer.service.js';

@Module({
  imports: [ConfigModule, UsageModule],
  controllers: [AssessmentsController],
  providers: [AssessmentsService, AssessmentAiService, PdfRendererService],
  exports: [PdfRendererService],
})
export class DocumentsModule {}
