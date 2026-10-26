import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller.js';

@Module({
  controllers: [DocumentsController]
})
export class DocumentsModule {}
