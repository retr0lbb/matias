import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GeminiModule } from '../ai/gemini.client.js';
import { UsageModule } from '../usage/usage.module.js';
import { DocumentAiService } from './ai/document-ai.service.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { PdfRendererService } from './pdf/pdf-renderer.service.js';

@Module({
  imports: [ConfigModule, GeminiModule, UsageModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentAiService, PdfRendererService],
  exports: [PdfRendererService, DocumentsService],
})
export class DocumentsModule {}
