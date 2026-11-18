import { boolean, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const loginProviderEnum = pgEnum("login_provider_enum", ["LOCAL", "GOOGLE"]);

export const userTable = pgTable("users", {
	id: uuid().primaryKey().defaultRandom(),
	name: varchar().notNull(),
	email: varchar().unique().notNull(),
	emailVerified: boolean().default(false),
	passwordHash: varchar("passwd_hash"),
	loginProvider: loginProviderEnum().notNull().default("LOCAL"),
	googleSubject: varchar("google_subject").unique(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	// Day the usage cycle (weekly or monthly, per plan) is anchored to. Reset on plan activation.
	cycleAnchorAt: timestamp("cycle_anchor_at").defaultNow().notNull(),
});

export type User = typeof userTable.$inferSelect;
export type NewUser = typeof userTable.$inferInsert;
