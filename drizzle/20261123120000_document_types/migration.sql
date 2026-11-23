-- Hand-written. Replaces 20261118182314_document_types and 20261118185838_group_work_type from
-- feat/document-generation, re-dated after 20261122050422_google_integrations so databases that
-- already applied main's migrations still run it (drizzle skips migrations older than the last one).
-- A rename must keep the data (the generator would drop and recreate the table).
-- Postgres keeps the old names of the primary key, foreign keys and index, so they are renamed too:
-- that way the snapshot, built from the new schema, matches the real database.
CREATE TYPE "document_type" AS ENUM('assessment', 'homework', 'lesson_plan', 'course_syllabus', 'group_work');--> statement-breakpoint
ALTER TABLE "assessments" RENAME TO "documents";--> statement-breakpoint
-- Every document that exists today is an assessment.
ALTER TABLE "documents" ADD COLUMN "type" "document_type" DEFAULT 'assessment' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" RENAME CONSTRAINT "assessments_pkey" TO "documents_pkey";--> statement-breakpoint
ALTER TABLE "documents" RENAME CONSTRAINT "assessments_user_id_users_id_fkey" TO "documents_user_id_users_id_fkey";--> statement-breakpoint
ALTER INDEX "assessments_user_created_at_index" RENAME TO "documents_user_created_at_index";--> statement-breakpoint
ALTER TABLE "document_credits" RENAME COLUMN "assessment_id" TO "document_id";--> statement-breakpoint
ALTER TABLE "document_credits" RENAME CONSTRAINT "document_credits_assessment_id_assessments_id_fkey" TO "document_credits_document_id_documents_id_fkey";
