import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { messagesTable } from "./message.js";
import { userTable } from "./user.js";

export const ragDocumentStatusEnum = pgEnum("rag_document_status", [
  "PROCESSING",
  "READY",
  "FAILED",
]);

export const ragDocumentsTable = pgTable(
  "rag_documents",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => userTable.id, { onDelete: "cascade" })
      .notNull(),
    conversationId: uuid("conversation_id"),
    // The user message the file was sent with; set when that message is saved.
    messageId: uuid("message_id").references(() => messagesTable.id, {
      onDelete: "set null",
    }),
    filename: varchar().notNull(),
    mimeType: varchar("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storagePath: varchar("storage_path").notNull(),
    status: ragDocumentStatusEnum().notNull().default("PROCESSING"),
    error: text(),
    createdAt: timestamp().defaultNow().notNull(),
    updatedAt: timestamp().$onUpdateFn(() => new Date()).defaultNow(),
  },
  (tb) => [
    index("rag_documents_user_status_index").on(tb.userId, tb.status),
    index("rag_documents_user_conversation_index").on(
      tb.userId,
      tb.conversationId,
    ),
    index("rag_documents_user_created_at_index").on(tb.userId, tb.createdAt),
    index("rag_documents_message_id_index").on(tb.messageId),
  ],
);

export type RagDocument = typeof ragDocumentsTable.$inferSelect;
export type NewRagDocument = typeof ragDocumentsTable.$inferInsert;
