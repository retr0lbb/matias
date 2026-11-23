import type { EmailTokenPurpose, MfaState } from "@nestjs/authentication";
import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { userTable } from "./user.js";

// State of @nestjs/authentication, which would otherwise live in process
// memory (lost on restart, refused in production). See specs/auth-storage.md.

export const authSessionsTable = pgTable(
	"auth_sessions",
	{
		// SHA-256 of the cookie token; the token itself is never stored.
		id: text().primaryKey(),
		userId: uuid("user_id")
			.references(() => userTable.id, { onDelete: "cascade" })
			.notNull(),
		createdAt: timestamp("created_at").notNull(),
		expiresAt: timestamp("expires_at").notNull(),
		lastActiveAt: timestamp("last_active_at").notNull(),
		mfa: text().$type<MfaState>(),
		metadata: jsonb().$type<Record<string, unknown>>(),
	},
	(tb) => [
		index("auth_sessions_user_id_index").on(tb.userId),
		index("auth_sessions_expires_at_index").on(tb.expiresAt),
	],
);

/** Google (OIDC) logins between the redirect to the provider and the callback. */
export const authOidcStatesTable = pgTable(
	"auth_oidc_states",
	{
		// SHA-256 of the secret in the browser's transaction cookie.
		state: text().primaryKey(),
		provider: text().notNull(),
		codeVerifier: text("code_verifier").notNull(),
		nonce: text(),
		redirectTo: text("redirect_to"),
		link: jsonb().$type<{ userId: string; sessionId: string }>(),
		createdAt: timestamp("created_at").notNull(),
		expiresAt: timestamp("expires_at").notNull(),
	},
	(tb) => [index("auth_oidc_states_expires_at_index").on(tb.expiresAt)],
);

/** Email verification (and password reset) links. */
export const authEmailTokensTable = pgTable(
	"auth_email_tokens",
	{
		id: text().primaryKey(),
		purpose: text().$type<EmailTokenPurpose>().notNull(),
		userId: uuid("user_id")
			.references(() => userTable.id, { onDelete: "cascade" })
			.notNull(),
		email: varchar().notNull(),
		fingerprint: text(),
		createdAt: timestamp("created_at").notNull(),
		expiresAt: timestamp("expires_at").notNull(),
	},
	(tb) => [
		index("auth_email_tokens_user_purpose_index").on(tb.userId, tb.purpose),
		index("auth_email_tokens_expires_at_index").on(tb.expiresAt),
	],
);

export type AuthSessionRow = typeof authSessionsTable.$inferSelect;
export type AuthOidcStateRow = typeof authOidcStatesTable.$inferSelect;
export type AuthEmailTokenRow = typeof authEmailTokensTable.$inferSelect;
