CREATE TYPE "document_credit_reason" AS ENUM('GENERATE', 'EXTRA_CHANGES');--> statement-breakpoint
CREATE TABLE "document_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"assessment_id" uuid,
	"reason" "document_credit_reason" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "document_credits_user_created_at_index" ON "document_credits" ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "document_credits" ADD CONSTRAINT "document_credits_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_credits" ADD CONSTRAINT "document_credits_assessment_id_assessments_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE SET NULL;--> statement-breakpoint
-- Hand-added: document limits in plans.limits (validated on read, so every row needs them).
UPDATE "plans" SET "limits" = "limits" || '{"documentsPerCycle": 3, "aiChangesPerDocument": 7}'::jsonb WHERE "slug" = 'free' AND "limits" IS NOT NULL;--> statement-breakpoint
UPDATE "plans" SET "limits" = "limits" || '{"documentsPerCycle": 30, "aiChangesPerDocument": 7}'::jsonb WHERE "slug" = 'pro' AND "limits" IS NOT NULL;--> statement-breakpoint
-- Any other plan gets the feature off until its limits are set by hand.
UPDATE "plans" SET "limits" = "limits" || '{"documentsPerCycle": 0, "aiChangesPerDocument": 7}'::jsonb WHERE "limits" IS NOT NULL AND NOT ("limits" ? 'documentsPerCycle');--> statement-breakpoint
-- Hand-added: credits already spent under the old counting (1 per assessment + 1 per extra block of 7 AI changes).
INSERT INTO "document_credits" ("user_id", "assessment_id", "reason", "created_at")
SELECT "user_id", "id", 'GENERATE', "created_at" FROM "assessments";--> statement-breakpoint
INSERT INTO "document_credits" ("user_id", "assessment_id", "reason", "created_at")
SELECT a."user_id", a."id", 'EXTRA_CHANGES', a."updated_at"
FROM "assessments" a
CROSS JOIN LATERAL generate_series(1, greatest(ceil(a."ai_revisions"::numeric / 7)::int - 1, 0));
