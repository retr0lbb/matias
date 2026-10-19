CREATE TYPE "login_provider_enum" AS ENUM('LOCAL', 'GOOGLE');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar NOT NULL,
	"email" varchar NOT NULL UNIQUE,
	"emailVerified" boolean DEFAULT false,
	"passwd_hash" varchar,
	"loginProvider" "login_provider_enum" DEFAULT 'LOCAL'::"login_provider_enum" NOT NULL
);
