import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { EmbeddingService } from "./embedding.service.js";
import { RagDocumentsController } from "./rag-documents.controller.js";
import { RagDocumentsService } from "./rag-documents.service.js";
import { RagService } from "./rag.service.js";
import { UsageModule } from "../usage/usage.module.js";

@Module({
  imports: [ConfigModule, UsageModule],
  controllers: [RagDocumentsController],
  providers: [RagService, RagDocumentsService, EmbeddingService],
  exports: [RagService, EmbeddingService],
})
export class RagModule {}
