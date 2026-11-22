import { pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { userTable } from "./user.js";

/**
 * The Google account a user connected for Classroom ("Connect Classroom"),
 * which may differ from the account they sign in with. One per user. Tokens
 * are AES-256-GCM encrypted (see `TokenCipher`), never stored in clear.
 */
export const googleIntegrationsTable = pgTable("google_integrations", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => userTable.id, { onDelete: "cascade" }),
	googleSubject: varchar("google_subject").notNull(),
	googleEmail: varchar("google_email"),
	refreshTokenEnc: text("refresh_token_enc").notNull(),
	accessTokenEnc: text("access_token_enc"),
	accessTokenExpiresAt: timestamp("access_token_expires_at"),
	/** Space-separated scopes Google granted. */
	scopes: text().notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.$onUpdateFn(() => new Date())
		.defaultNow()
		.notNull(),
	/** Set when Google refused the refresh token (revoked or expired); reconnecting clears it. */
	revokedAt: timestamp("revoked_at"),
});

export type GoogleIntegration = typeof googleIntegrationsTable.$inferSelect;
