import { Module } from "@nestjs/common";
import { RagModule } from "../rag/rag.module.js";
import { ConversationContextService } from "./conversation-context.service.js";

@Module({
  imports: [RagModule],
  providers: [ConversationContextService],
  exports: [ConversationContextService],
})
export class ConversationModule {}
