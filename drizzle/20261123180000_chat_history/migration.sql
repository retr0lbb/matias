-- Hand-written. The chat list sorts on "updatedAt" alone, so it can no longer be NULL.
-- Conversations without one take the time of their last message, or their creation time.
UPDATE "conversations" AS c
SET "updatedAt" = COALESCE(
	(SELECT MAX(m."createdAt") FROM "messages" AS m WHERE m."conversationId" = c."id"),
	c."createdAt"
)
WHERE c."updatedAt" IS NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "updatedAt" SET NOT NULL;--> statement-breakpoint
-- The user message a file was sent with, so old chats can show attachments on their bubble.
ALTER TABLE "rag_documents" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "rag_documents" ADD CONSTRAINT "rag_documents_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX "rag_documents_message_id_index" ON "rag_documents" ("message_id");
