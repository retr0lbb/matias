import { Injectable, Logger } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, asc, cosineDistance, eq } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { unlink } from "node:fs/promises";
import { extname } from "node:path";
import { ragChunksTable } from "../db/schemas/rag-chunk.js";
import {
  ragDocumentsTable,
  type RagDocument,
} from "../db/schemas/rag-document.js";
import { chunkText } from "./chunker.js";
import { EmbeddingService } from "./embedding.service.js";
import { extractDocxText } from "./extractors/docx.extractor.js";
import { extractPdfText } from "./extractors/pdf.extractor.js";

// Each chunk row binds 6 parameters; 1000 rows keeps us well under the 65535 limit.
const CHUNK_INSERT_BATCH_SIZE = 1000;
const SEARCH_LIMIT = 5;

export interface RagSearchResult {
  chunkId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  content: string;
  similarity: number;
}

export interface RagSearchOptions {
  documentId?: string;
  conversationId?: string;
}

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    @InjectDrizzle() private readonly db: NodePgDatabase,
    private readonly embeddingService: EmbeddingService,
  ) {}

  async processDocument(documentId: string): Promise<void> {
    let storagePath: string | undefined;

    try {
      const [document] = await this.db
        .select()
        .from(ragDocumentsTable)
        .where(eq(ragDocumentsTable.id, documentId));

      if (!document) {
        throw new Error("Document not found");
      }

      storagePath = document.storagePath;

      const text = await this.extractText(document);
      if (text.trim().length === 0) {
        throw new Error("Document has no extractable text");
      }

      const chunks = chunkText(text);
      if (chunks.length === 0) {
        throw new Error("Document produced no chunks");
      }

      const embeddings = await this.embeddingService.embed(
        chunks.map((chunk) => chunk.content),
      );

      await this.db.transaction(async (tx) => {
        for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH_SIZE) {
          const batch = chunks.slice(i, i + CHUNK_INSERT_BATCH_SIZE);

          await tx.insert(ragChunksTable).values(
            batch.map((chunk, offset) => ({
              documentId: document.id,
              conversationId: document.conversationId,
              chunkIndex: chunk.index,
              content: chunk.content,
              tokenCount: chunk.tokenCount,
              embedding: embeddings[i + offset],
            })),
          );
        }

        await tx
          .update(ragDocumentsTable)
          .set({ status: "READY", error: null })
          .where(eq(ragDocumentsTable.id, document.id));
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown processing error";

      await this.markFailed(documentId, message);
      this.logger.error(
        `RAG processing failed for document ${documentId}: ${message}`,
      );
    } finally {
      if (storagePath) {
        await unlink(storagePath).catch(() => undefined);
      }
    }
  }

  async search(
    query: string,
    userId: string,
    options: RagSearchOptions = {},
  ): Promise<RagSearchResult[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      throw new Error("Query must not be empty");
    }

    const [vector] = await this.embeddingService.embed([trimmed]);
    if (!vector) {
      throw new Error("Could not embed the query");
    }

    const distance = cosineDistance(ragChunksTable.embedding, vector);

    const rows = await this.db
      .select({
        chunkId: ragChunksTable.id,
        documentId: ragChunksTable.documentId,
        filename: ragDocumentsTable.filename,
        chunkIndex: ragChunksTable.chunkIndex,
        content: ragChunksTable.content,
        distance,
      })
      .from(ragChunksTable)
      .innerJoin(
        ragDocumentsTable,
        eq(ragChunksTable.documentId, ragDocumentsTable.id),
      )
      .where(
        and(
          eq(ragDocumentsTable.userId, userId),
          eq(ragDocumentsTable.status, "READY"),
          options.documentId
            ? eq(ragDocumentsTable.id, options.documentId)
            : undefined,
          options.conversationId
            ? eq(ragDocumentsTable.conversationId, options.conversationId)
            : undefined,
        ),
      )
      .orderBy(asc(distance))
      .limit(SEARCH_LIMIT);

    return rows.map((row) => ({
      chunkId: row.chunkId,
      documentId: row.documentId,
      filename: row.filename,
      chunkIndex: row.chunkIndex,
      content: row.content,
      similarity: Number((1 - Number(row.distance)).toFixed(4)),
    }));
  }

  private extractText(document: RagDocument): Promise<string> {
    const extension = extname(document.filename).toLowerCase();

    if (extension === ".pdf") {
      return extractPdfText(document.storagePath);
    }

    if (extension === ".docx") {
      return extractDocxText(document.storagePath);
    }

    throw new Error("Unsupported file type");
  }

  private async markFailed(documentId: string, error: string): Promise<void> {
    try {
      await this.db
        .update(ragDocumentsTable)
        .set({ status: "FAILED", error })
        .where(eq(ragDocumentsTable.id, documentId));
    } catch (dbError) {
      const message =
        dbError instanceof Error ? dbError.message : String(dbError);
      this.logger.error(
        `Failed to mark document ${documentId} as FAILED: ${message}`,
      );
    }
  }
}
