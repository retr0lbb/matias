import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { EmbeddingService } from "./embedding.service.js";
import { RagController } from "./rag.controller.js";
import { RagDocumentsController } from "./rag-documents.controller.js";
import { RagDocumentsService } from "./rag-documents.service.js";
import { RagService } from "./rag.service.js";

@Module({
  imports: [ConfigModule],
  controllers: [RagController, RagDocumentsController],
  providers: [RagService, RagDocumentsService, EmbeddingService],
  exports: [RagService, EmbeddingService],
})
export class RagModule {}
