import { pgTable, varchar, uuid, pgEnum, boolean, timestamp } from "drizzle-orm/pg-core";

export const loginProviderEnum = pgEnum("login_provider_enum", [
  "LOCAL",
  "GOOGLE"
]);

export const planEnum = pgEnum("plan_enum", ["FREE", "PRO"]);

export type Plan = (typeof planEnum.enumValues)[number];

export const userTable = pgTable("users", {
    id: uuid().primaryKey().defaultRandom(),
    name: varchar().notNull(),
    email: varchar().unique().notNull(),
    emailVerified: boolean().default(false),
    passwordHash: varchar("passwd_hash"),
    loginProvider: loginProviderEnum().notNull().default("LOCAL"),
    googleSubject: varchar("google_subject").unique(),
    plan: planEnum().notNull().default("FREE"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // Day of month the usage cycle resets on. Billing will reset it on plan changes.
    cycleAnchorAt: timestamp("cycle_anchor_at").defaultNow().notNull(),
  }
);

export type User = typeof userTable.$inferSelect;
export type NewUser = typeof userTable.$inferInsert;
