import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConversationModule } from '../conversation/conversation.module.js';
import { UsageModule } from '../usage/usage.module.js';
import { DocumentAiService } from './ai/document-ai.service.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { PdfRendererService } from './pdf/pdf-renderer.service.js';

@Module({
  imports: [ConfigModule, ConversationModule, UsageModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentAiService, PdfRendererService],
  exports: [PdfRendererService],
})
export class DocumentsModule {}
