ALTER TYPE "payment_status_enum" ADD VALUE 'OVERDUE';--> statement-breakpoint
ALTER TYPE "payment_status_enum" ADD VALUE 'REFUNDED';--> statement-breakpoint
ALTER TABLE "payments" RENAME COLUMN "next_due_date" TO "due_date";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "asaas_payment_id" varchar NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "paid_at" timestamp;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "due_date" SET DATA TYPE date USING "due_date"::date;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_asaas_payment_id_key" UNIQUE("asaas_payment_id");