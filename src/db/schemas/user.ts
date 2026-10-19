import { pgTable, varchar, uuid, pgEnum } from "drizzle-orm/pg-core";

export const loginProviderEnum = pgEnum("login_provider_enum", [
  "LOCAL",
  "GOOGLE"
]);

export const userTable = pgTable("users", {
    id: uuid().primaryKey().defaultRandom(),
    name: varchar().notNull(),
    email: varchar().unique().notNull(),
    passwordHash: varchar("passwd_hash"),
    loginProvider: loginProviderEnum().notNull().default("LOCAL")
})

export type User = typeof userTable.$inferSelect;
export type NewUser = typeof userTable.$inferInsert;