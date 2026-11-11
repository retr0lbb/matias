import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller.js';
import { PdfRendererService } from './assessment/pdf/pdf-renderer.service.js';

@Module({
  controllers: [DocumentsController],
  providers: [PdfRendererService],
  exports: [PdfRendererService],
})
export class DocumentsModule {}
