import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { ragDocumentsTable } from "./rag-document.js";

export const ragChunksTable = pgTable(
  "rag_chunks",
  {
    id: uuid().primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .references(() => ragDocumentsTable.id, { onDelete: "cascade" })
      .notNull(),
    conversationId: uuid("conversation_id"),
    chunkIndex: integer("chunk_index").notNull(),
    content: text().notNull(),
    tokenCount: integer("token_count").notNull(),
    embedding: vector("embedding", { dimensions: 768 }).notNull(),
    createdAt: timestamp().defaultNow().notNull(),
  },
  (tb) => [
    index("rag_chunks_document_id_index").on(tb.documentId),
    index("rag_chunks_embedding_hnsw_index").using(
      "hnsw",
      tb.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export type RagChunk = typeof ragChunksTable.$inferSelect;
export type NewRagChunk = typeof ragChunksTable.$inferInsert;
