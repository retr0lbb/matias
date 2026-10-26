ALTER TABLE "users" ADD COLUMN "google_subject" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_google_subject_key" UNIQUE("google_subject");