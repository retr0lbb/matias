ALTER TABLE "rag_chunks" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "rag_documents" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
CREATE INDEX "rag_documents_user_conversation_index" ON "rag_documents" ("user_id","conversation_id");