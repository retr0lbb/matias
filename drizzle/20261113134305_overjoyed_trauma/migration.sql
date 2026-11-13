CREATE TYPE "billing_type_enum" AS ENUM('PIX', 'BOLETO', 'CARTAO_DE_CREDITO');--> statement-breakpoint
CREATE TYPE "payment_status_enum" AS ENUM('PENDING', 'PAID', 'FAILED');--> statement-breakpoint
CREATE TYPE "promo_code_redemption_status_enum" AS ENUM('PENDING', 'APPLIED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "discount_type" AS ENUM('FIXED', 'PERCENTAGE');--> statement-breakpoint
CREATE TYPE "subscription_status" AS ENUM('PENDING', 'ACTIVE', 'EXPIRED', 'INACTIVE');--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid,
	"subscription_id" uuid,
	"customerId" varchar NOT NULL,
	"billing_type" "billing_type_enum" NOT NULL,
	"next_due_date" timestamp,
	"status" "payment_status_enum" DEFAULT 'PENDING'::"payment_status_enum",
	"value" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"price" integer NOT NULL,
	"currency" text NOT NULL,
	"billing_interval" varchar NOT NULL,
	"is_active" boolean DEFAULT false,
	"limits" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "promo_code_redemption" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"promo_code_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"subscription_id" uuid,
	"status" "promo_code_redemption_status_enum" DEFAULT 'PENDING'::"promo_code_redemption_status_enum",
	"discount_type" "discount_type",
	"duration_in_cicles" integer NOT NULL,
	"discount_value" integer NOT NULL,
	"redeemed_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"code" varchar NOT NULL UNIQUE,
	"description" text,
	"discount_type" "discount_type",
	"duration_in_cicles" integer NOT NULL,
	"discount_value" integer NOT NULL,
	"max_redemptions_global" integer,
	"max_redemptions_user" integer,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"isValid" boolean,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid,
	"plan_id" uuid,
	"status" "subscription_status" DEFAULT 'PENDING'::"subscription_status",
	"subscribed_at" timestamp DEFAULT now(),
	"cancelled_at" timestamp,
	"cancel_reason" text,
	"customerId" varchar NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_subscriptions_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id");--> statement-breakpoint
ALTER TABLE "promo_code_redemption" ADD CONSTRAINT "promo_code_redemption_promo_code_id_promo_codes_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "promo_codes"("id");--> statement-breakpoint
ALTER TABLE "promo_code_redemption" ADD CONSTRAINT "promo_code_redemption_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "promo_code_redemption" ADD CONSTRAINT "promo_code_redemption_subscription_id_subscriptions_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id");