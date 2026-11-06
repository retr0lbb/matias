CREATE TYPE "message_expense" AS ENUM('CHEAP', 'NORMAL', 'EXPENSIVE');--> statement-breakpoint
CREATE TYPE "plan_enum" AS ENUM('FREE', 'PRO');--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "expense" "message_expense";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plan" "plan_enum" DEFAULT 'FREE'::"plan_enum" NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "cycle_anchor_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "rag_documents_user_created_at_index" ON "rag_documents" ("user_id","createdAt");