CREATE TABLE "auth_email_tokens" (
	"id" text PRIMARY KEY,
	"purpose" text NOT NULL,
	"user_id" uuid NOT NULL,
	"email" varchar NOT NULL,
	"fingerprint" text,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_oidc_states" (
	"state" text PRIMARY KEY,
	"provider" text NOT NULL,
	"code_verifier" text NOT NULL,
	"nonce" text,
	"redirect_to" text,
	"link" jsonb,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_active_at" timestamp NOT NULL,
	"mfa" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE INDEX "auth_email_tokens_user_purpose_index" ON "auth_email_tokens" ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "auth_email_tokens_expires_at_index" ON "auth_email_tokens" ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_oidc_states_expires_at_index" ON "auth_oidc_states" ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_index" ON "auth_sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_at_index" ON "auth_sessions" ("expires_at");--> statement-breakpoint
ALTER TABLE "auth_email_tokens" ADD CONSTRAINT "auth_email_tokens_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;