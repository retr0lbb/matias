CREATE TYPE "message_status" AS ENUM('FAILED', 'COMPLETED', 'ERROR');--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "title" varchar;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "interaction_id" varchar;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "status" "message_status";--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "updatedAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "createdAt" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "user_id_updated_at_index" ON "conversations" ("user_id","updatedAt");--> statement-breakpoint
CREATE INDEX "conversationid_created_at_index" ON "messages" ("conversationId","createdAt");--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_user_id_users_id_fkey", ADD CONSTRAINT "conversations_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_conversationId_conversations_id_fkey", ADD CONSTRAINT "messages_conversationId_conversations_id_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE;