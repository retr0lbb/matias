ALTER TABLE "assessments" ADD COLUMN "prompt" text;--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "ai_revisions" integer DEFAULT 0 NOT NULL;