import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, count, eq } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { open, unlink } from "node:fs/promises";
import { extname } from "node:path";
import { ragChunksTable } from "../db/schemas/rag-chunk.js";
import {
  ragDocumentsTable,
  type RagDocument,
} from "../db/schemas/rag-document.js";
import { RagService } from "./rag.service.js";

const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const OCTET_STREAM = "application/octet-stream";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UploadedRagDocument {
  documentId: string;
  filename: string;
  status: string;
  conversationId: string | null;
}

export interface RejectedRagDocument {
  documentId: null;
  filename: string;
  status: "REJECTED";
  error: string;
}

@Injectable()
export class RagDocumentsService {
  private readonly logger = new Logger(RagDocumentsService.name);
  private processing: Promise<void> = Promise.resolve();

  constructor(
    @InjectDrizzle() private readonly db: NodePgDatabase,
    private readonly ragService: RagService,
  ) {}

  async uploadOne(
    file: Express.Multer.File | undefined,
    userId: string,
    conversationId?: string,
  ): Promise<UploadedRagDocument> {
    if (!file) {
      throw new BadRequestException("File is required");
    }

    try {
      await this.assertSupported(file);
      this.assertConversationId(conversationId);
    } catch (error) {
      await this.removeFile(file.path);
      throw error;
    }

    let document: RagDocument;
    try {
      [document] = await this.db
        .insert(ragDocumentsTable)
        .values({
          userId,
          conversationId: conversationId ?? null,
          filename: file.originalname,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          storagePath: file.path,
          status: "PROCESSING",
        })
        .returning();
    } catch (error) {
      await this.removeFile(file.path);
      throw error;
    }

    // Serialize documents: concurrent embedding calls would burst the shared
    // per-minute quota and trigger 429s.
    // shortcut: one worker per process, no queue; move to BullMQ when volume grows.
    this.processing = this.processing
      .then(() => this.ragService.processDocument(document.id))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to start RAG processing for document ${document.id}: ${message}`,
        );
      });

    return {
      documentId: document.id,
      filename: document.filename,
      status: document.status,
      conversationId: document.conversationId,
    };
  }

  async uploadMany(
    files: Express.Multer.File[],
    userId: string,
    conversationId?: string,
  ): Promise<{ documents: Array<UploadedRagDocument | RejectedRagDocument> }> {
    const documents: Array<UploadedRagDocument | RejectedRagDocument> = [];

    for (const file of files) {
      try {
        documents.push(await this.uploadOne(file, userId, conversationId));
      } catch (error) {
        documents.push({
          documentId: null,
          filename: file.originalname,
          status: "REJECTED",
          error: error instanceof Error ? error.message : "Invalid file",
        });
      }
    }

    return { documents };
  }

  async getStatus(id: string, userId: string) {
    const [document] = await this.db
      .select()
      .from(ragDocumentsTable)
      .where(
        and(
          eq(ragDocumentsTable.id, id),
          eq(ragDocumentsTable.userId, userId),
        ),
      );

    if (!document) {
      throw new NotFoundException("Document not found");
    }

    const [chunkCount] = await this.db
      .select({ value: count() })
      .from(ragChunksTable)
      .where(eq(ragChunksTable.documentId, id));

    return {
      id: document.id,
      filename: document.filename,
      status: document.status,
      error: document.error,
      chunkCount: Number(chunkCount?.value ?? 0),
      conversationId: document.conversationId,
      createdAt: document.createdAt,
    };
  }

  private async assertSupported(file: Express.Multer.File): Promise<void> {
    const extension = extname(file.originalname).toLowerCase();

    if (extension !== ".pdf" && extension !== ".docx") {
      throw new BadRequestException(
        "Unsupported file type. Only PDF and DOCX are allowed",
      );
    }

    if (
      file.mimetype !== PDF_MIME &&
      file.mimetype !== DOCX_MIME &&
      file.mimetype !== OCTET_STREAM
    ) {
      throw new BadRequestException("Unsupported file MIME type");
    }

    const header = Buffer.alloc(4);
    const handle = await open(file.path, "r");

    try {
      await handle.read(header, 0, header.length, 0);
    } finally {
      await handle.close();
    }

    if (extension === ".pdf" && header.toString("latin1") !== "%PDF") {
      throw new BadRequestException("File is not a valid PDF");
    }

    const isZip =
      header[0] === 0x50 &&
      header[1] === 0x4b &&
      header[2] === 0x03 &&
      header[3] === 0x04;

    if (extension === ".docx" && !isZip) {
      throw new BadRequestException("File is not a valid DOCX");
    }
  }

  private assertConversationId(conversationId?: string): void {
    if (conversationId === undefined) {
      return;
    }

    if (!UUID_PATTERN.test(conversationId)) {
      throw new BadRequestException("conversationId must be a UUID");
    }
  }

  private async removeFile(path: string): Promise<void> {
    await unlink(path).catch(() => undefined);
  }
}
