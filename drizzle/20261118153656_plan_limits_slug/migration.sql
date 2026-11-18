-- Hand-edited: backfill slug before NOT NULL, seed the free plan and plan limits.
ALTER TABLE "plans" ADD COLUMN "slug" varchar;--> statement-breakpoint
UPDATE "plans" SET "slug" = trim(both '-' from regexp_replace(lower(trim("name")), '[^a-z0-9]+', '-', 'g')) WHERE "slug" IS NULL;--> statement-breakpoint
INSERT INTO "plans" ("slug", "name", "description", "price", "currency", "billing_interval", "is_active")
SELECT 'free', 'Free', 'Plano gratuito', 0, 'BRL', 'NONE', false
WHERE NOT EXISTS (SELECT 1 FROM "plans" WHERE "slug" = 'free');--> statement-breakpoint
UPDATE "plans" SET "limits" = '{
  "cycle": "WEEKLY",
  "uploadsPerCycle": 5,
  "maxFileBytes": 10485760,
  "storageBytes": 209715200,
  "messagesPerCycle": { "cheap": null, "normal": 5, "expensive": 2 },
  "maxThinkingLevel": "HIGH"
}'::jsonb WHERE "slug" = 'free';--> statement-breakpoint
UPDATE "plans" SET "limits" = '{
  "cycle": "MONTHLY",
  "uploadsPerCycle": 100,
  "maxFileBytes": 20971520,
  "storageBytes": 2147483648,
  "messagesPerCycle": { "cheap": null, "normal": 300, "expensive": 100 },
  "maxThinkingLevel": "ULTRA_HIGH"
}'::jsonb WHERE "slug" = 'pro';--> statement-breakpoint
ALTER TABLE "plans" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_slug_key" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "plan";--> statement-breakpoint
DROP TYPE "plan_enum";
