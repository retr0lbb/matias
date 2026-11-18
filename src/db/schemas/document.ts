import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { StoredDocument } from "../../documents/schemas/document.schema.js";
import { DOCUMENT_TYPES } from "../../documents/types/document-type.js";
import { userTable } from "./user.js";

export const documentTypeEnum = pgEnum("document_type", DOCUMENT_TYPES);

export type DocumentTypeName = (typeof documentTypeEnum.enumValues)[number];

export const documentsTable = pgTable(
	"documents",
	{
		id: uuid().primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.references(() => userTable.id, { onDelete: "cascade" })
			.notNull(),
		// No FK, same as rag_documents: clients may pre-generate conversation ids.
		conversationId: uuid("conversation_id"),
		// Decides the block kinds, the header, the answer key and the prompts.
		type: documentTypeEnum().notNull().default("assessment"),
		// Single source of truth; HTML, PDF and DOCX are derived from it on demand.
		document: jsonb().$type<StoredDocument>().notNull(),
		// Bumped on every change, for optimistic concurrency.
		version: integer().notNull().default(1),
		// The request the content was last generated from; reused by regenerate.
		prompt: text(),
		// AI changes (revise/regenerate) applied so far; manual patches are free.
		aiRevisions: integer("ai_revisions").notNull().default(0),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.$onUpdateFn(() => new Date())
			.defaultNow()
			.notNull(),
	},
	(tb) => [index("documents_user_created_at_index").on(tb.userId, tb.createdAt)],
);

export type DocumentRow = typeof documentsTable.$inferSelect;
export type NewDocumentRow = typeof documentsTable.$inferInsert;

export const documentCreditReasonEnum = pgEnum("document_credit_reason", [
	"GENERATE",
	"EXTRA_CHANGES",
]);

/**
 * One row per document credit spent. Usage per cycle is the count of rows in
 * the cycle, so credits land in the cycle they were spent in.
 */
export const documentCreditsTable = pgTable(
	"document_credits",
	{
		id: uuid().primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.references(() => userTable.id, { onDelete: "cascade" })
			.notNull(),
		// Kept when the document is deleted: the credit was still spent.
		documentId: uuid("document_id").references(() => documentsTable.id, {
			onDelete: "set null",
		}),
		reason: documentCreditReasonEnum().notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(tb) => [index("document_credits_user_created_at_index").on(tb.userId, tb.createdAt)],
);

export type DocumentCreditReason = (typeof documentCreditReasonEnum.enumValues)[number];
