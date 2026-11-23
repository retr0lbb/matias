import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, desc, eq, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type DocumentRow, documentsTable } from '../db/schemas/document.js';
import {
  type DbExecutor,
  type DocumentAllowance,
  UsageService,
  type UsageSubject,
} from '../usage/usage.service.js';
import type { ThinkingLevelOption } from '../usage/plan-limits.js';
import {
  DocumentAiService,
  type DocumentAiOptions,
  type DocumentAiUsage,
} from './ai/document-ai.service.js';
import { assignIds } from './build/assign-ids.js';
import { applyPatch } from './patch/apply-patch.js';
import { PdfRendererService } from './pdf/pdf-renderer.service.js';
import { renderAnswerKey } from './render/render-answer-key.js';
import { renderDocumentDocx } from './render/render-docx.js';
import { renderDocumentHtml } from './render/render-html.js';
import {
  DOCUMENT_SCHEMA_VERSION,
  type StoredDocument,
  upgradeDocument,
} from './schemas/document.schema.js';
import type { DocumentPatch } from './schemas/patch.schema.js';
import type { DocumentType } from './types/document-type.js';
import { getDocumentType } from './types/registry.js';

/**
 * AI work on documents comes only from the chat (AiService): the turn picks
 * the model, and `request` is the teacher's message with the conversation and
 * file context already added.
 */
interface ChatDocumentInput extends DocumentAiOptions {
  /** What the AI receives. */
  request: string;
}

export interface GenerateDocumentInput extends ChatDocumentInput {
  type: DocumentType;
  /** The teacher's own message, stored so a later regenerate can reuse it. */
  prompt: string;
  conversationId: string;
}

export type ReviseDocumentInput = ChatDocumentInput;

export type RegenerateDocumentInput = ChatDocumentInput;

export interface PatchDocumentInput {
  version: number;
  ops: DocumentPatch;
}

/** The saved document plus what the AI spent on it. */
export interface AiDocumentResult {
  kind: 'document';
  view: DocumentView;
  usage: DocumentAiUsage;
}

/** Nothing was saved and no credit was spent: the AI needs the teacher to answer this first. */
export interface AiClarificationResult {
  kind: 'clarification';
  question: string;
  usage: DocumentAiUsage;
}

export interface DocumentView {
  id: string;
  type: DocumentType;
  conversationId: string | null;
  /** Send it back with every manual change; a stale value is answered with 409. */
  version: number;
  prompt: string | null;
  aiRevisions: number;
  document: StoredDocument;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationDocumentSummary {
  id: string;
  type: DocumentType;
  title: string;
  createdAt: Date;
}

export interface RenderedPdf {
  filename: string;
  pdf: Buffer;
}

export interface RenderedDocx {
  filename: string;
  docx: Buffer;
}

const COMBINING_MARKS = /\p{M}/gu;

/** ASCII-only name, safe to put in a Content-Disposition header. */
function toFilename(title: string, fallback: string): string {
  const slug = title
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return slug || fallback;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @InjectDrizzle() private readonly db: NodePgDatabase,
    private readonly documentAi: DocumentAiService,
    private readonly pdfRenderer: PdfRendererService,
    private readonly usageService: UsageService,
  ) {}

  async generate(
    user: UsageSubject,
    input: GenerateDocumentInput,
  ): Promise<AiDocumentResult | AiClarificationResult> {
    const type = getDocumentType(input.type);
    // Fail before paying for the AI call; checked again under lock on insert.
    const allowance = await this.usageService.getDocumentAllowance(this.db, user);
    this.usageService.assertThinkingLevelAllowed(allowance, input.thinkingLevel);
    this.usageService.assertCanSpendDocumentCredit(allowance, 'GENERATE');

    const generated = await this.documentAi.generate(type, input.request, input);
    if (generated.kind === 'clarification') {
      // Nothing is stored and no credit is spent: the teacher answers and asks again.
      return generated;
    }

    // The header text comes from what the teacher said in the chat; the theme starts at the defaults.
    const document = type.schemas.document.parse({
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      content: assignIds(generated.content),
      header: generated.header,
      theme: {},
    });

    const row = await this.db.transaction(async (tx) => {
      await this.usageService.lockUser(tx, user.id);
      this.usageService.assertCanSpendDocumentCredit(
        await this.usageService.getDocumentAllowance(tx, user),
        'GENERATE',
      );

      const [inserted] = await tx
        .insert(documentsTable)
        .values({
          userId: user.id,
          type: input.type,
          conversationId: input.conversationId,
          document,
          prompt: input.prompt,
        })
        .returning();

      await this.usageService.recordDocumentCredit(tx, {
        userId: user.id,
        documentId: inserted.id,
        reason: 'GENERATE',
      });

      return inserted;
    });

    return { kind: 'document', view: this.toView(row, document), usage: generated.usage };
  }

  /** Id, type, title and creation time of the conversation's documents, newest first. */
  async listByConversation(
    userId: string,
    conversationId: string,
    limit: number,
  ): Promise<ConversationDocumentSummary[]> {
    const rows = await this.db
      .select({
        id: documentsTable.id,
        type: documentsTable.type,
        document: documentsTable.document,
        createdAt: documentsTable.createdAt,
      })
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.userId, userId),
          eq(documentsTable.conversationId, conversationId),
        ),
      )
      .orderBy(desc(documentsTable.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.document?.content?.title ?? 'Sem título',
      createdAt: row.createdAt,
    }));
  }

  async get(id: string, userId: string): Promise<DocumentView> {
    const [row] = await this.db
      .select()
      .from(documentsTable)
      .where(
        and(eq(documentsTable.id, id), eq(documentsTable.userId, userId)),
      );

    // Same answer for "does not exist" and "belongs to someone else".
    if (!row) {
      throw new NotFoundException('Document not found');
    }

    // Rows saved by an older schema version are upgraded here and rewritten on their next save.
    const parsed = getDocumentType(row.type).schemas.document.safeParse(
      upgradeDocument(row.document),
    );
    if (!parsed.success) {
      this.logger.error(
        `Stored ${row.type} ${id} no longer matches the schema: ${parsed.error.message}`,
      );
      throw new InternalServerErrorException('Document could not be read');
    }

    return this.toView(row, parsed.data);
  }

  /** Manual change: no AI, no quota. */
  async patch(
    id: string,
    userId: string,
    input: PatchDocumentInput,
  ): Promise<DocumentView> {
    const current = await this.get(id, userId);
    this.assertVersion(current, input.version);

    const result = applyPatch(current.document, input.ops, getDocumentType(current.type));
    if (!result.success) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'The patch could not be applied',
        errors: result.errors,
      });
    }

    const [row] = await this.db
      .update(documentsTable)
      .set({ document: result.document, version: current.version + 1 })
      .where(this.atVersion(current, userId))
      .returning();

    if (!row) {
      throw this.versionConflict();
    }

    return this.toView(row, result.document);
  }

  /**
   * The AI turns the request into a patch; same engine as `patch`. Works on
   * the latest version; a change saved meanwhile is answered with 409.
   */
  async revise(
    id: string,
    user: UsageSubject,
    input: ReviseDocumentInput,
  ): Promise<AiDocumentResult> {
    const current = await this.get(id, user.id);
    await this.assertCanChangeWithAi(this.db, user, current, input.thinkingLevel);

    const revised = await this.documentAi.revise(
      getDocumentType(current.type),
      current.document,
      input.request,
      input,
    );
    const view = await this.saveAiRevision(current, user, { document: revised.document });

    return { kind: 'document', view, usage: revised.usage };
  }

  /**
   * New content from the request; the theme and the teacher's header are
   * kept, and header text the AI found only fills fields that are empty.
   */
  async regenerate(
    id: string,
    user: UsageSubject,
    input: RegenerateDocumentInput,
  ): Promise<AiDocumentResult | AiClarificationResult> {
    const current = await this.get(id, user.id);
    await this.assertCanChangeWithAi(this.db, user, current, input.thinkingLevel);

    const type = getDocumentType(current.type);
    const generated = await this.documentAi.generate(type, input.request, input);
    if (generated.kind === 'clarification') {
      return generated;
    }

    const document = type.schemas.document.parse({
      ...current.document,
      header: { ...generated.header, ...current.document.header },
      content: assignIds(generated.content),
    });
    const view = await this.saveAiRevision(current, user, { document });

    return { kind: 'document', view, usage: generated.usage };
  }

  async renderPreview(id: string, userId: string): Promise<string> {
    const { document, type } = await this.get(id, userId);
    return renderDocumentHtml(
      document.content,
      document.header,
      document.theme,
      getDocumentType(type),
    );
  }

  async renderPdf(id: string, userId: string): Promise<RenderedPdf> {
    const { document, type } = await this.get(id, userId);
    const definition = getDocumentType(type);
    const html = renderDocumentHtml(
      document.content,
      document.header,
      document.theme,
      definition,
    );

    return {
      filename: `${toFilename(document.content.title, definition.filenameFallback)}.pdf`,
      pdf: await this.pdfRenderer.render(html),
    };
  }

  async renderDocx(id: string, userId: string): Promise<RenderedDocx> {
    const { document, type } = await this.get(id, userId);
    const definition = getDocumentType(type);

    return {
      filename: `${toFilename(document.content.title, definition.filenameFallback)}.docx`,
      docx: await renderDocumentDocx(
        document.content,
        document.header,
        document.theme,
        definition,
      ),
    };
  }

  async renderAnswerKeyPreview(id: string, userId: string): Promise<string> {
    const { document, type } = await this.get(id, userId);
    const definition = this.answerKeyType(type);
    return renderAnswerKey(document.content, document.theme, definition.answerKeyTitle);
  }

  async renderAnswerKeyPdf(id: string, userId: string): Promise<RenderedPdf> {
    const { document, type } = await this.get(id, userId);
    const definition = this.answerKeyType(type);
    const html = renderAnswerKey(document.content, document.theme, definition.answerKeyTitle);
    const name = toFilename(document.content.title, definition.filenameFallback);

    return {
      // "...-gabarito.pdf", "...-guia-de-correcao.pdf"
      filename: `${name}-${toFilename(definition.answerKeyTitle, 'gabarito')}.pdf`,
      pdf: await this.pdfRenderer.render(html),
    };
  }

  private answerKeyType(type: DocumentType) {
    const definition = getDocumentType(type);
    if (!definition.hasAnswerKey) {
      throw new BadRequestException('This type of document has no answer key');
    }
    return definition;
  }

  /**
   * Before an AI change (revise/regenerate): the thinking level must be in the
   * plan, and a change that opens a new block of included changes needs a free
   * credit. Returns the allowance so callers under lock can reuse it.
   */
  private async assertCanChangeWithAi(
    executor: DbExecutor,
    user: UsageSubject,
    current: DocumentView,
    thinkingLevel?: ThinkingLevelOption,
  ): Promise<DocumentAllowance> {
    const allowance = await this.usageService.getDocumentAllowance(executor, user);

    if (thinkingLevel) {
      this.usageService.assertThinkingLevelAllowed(allowance, thinkingLevel);
    }
    if (this.usageService.extraCreditNeeded(allowance, current.aiRevisions)) {
      this.usageService.assertCanSpendDocumentCredit(allowance, 'EXTRA_CHANGES');
    }

    return allowance;
  }

  // Quota is re-checked under the per-user lock, and the write only lands if
  // nobody changed the document while the AI was working. The extra credit
  // is recorded only when the change actually lands.
  private async saveAiRevision(
    current: DocumentView,
    user: UsageSubject,
    changes: { document: StoredDocument; prompt?: string },
  ): Promise<DocumentView> {
    const row = await this.db.transaction(async (tx) => {
      await this.usageService.lockUser(tx, user.id);
      const allowance = await this.assertCanChangeWithAi(tx, user, current);

      const [updated] = await tx
        .update(documentsTable)
        .set({
          ...changes,
          version: current.version + 1,
          aiRevisions: sql`${documentsTable.aiRevisions} + 1`,
        })
        .where(this.atVersion(current, user.id))
        .returning();

      if (updated && this.usageService.extraCreditNeeded(allowance, current.aiRevisions)) {
        await this.usageService.recordDocumentCredit(tx, {
          userId: user.id,
          documentId: updated.id,
          reason: 'EXTRA_CHANGES',
        });
      }

      return updated;
    });

    if (!row) {
      throw this.versionConflict();
    }

    return this.toView(row, changes.document);
  }

  private atVersion(current: DocumentView, userId: string) {
    return and(
      eq(documentsTable.id, current.id),
      eq(documentsTable.userId, userId),
      eq(documentsTable.version, current.version),
    );
  }

  private assertVersion(current: DocumentView, version: number): void {
    if (current.version !== version) {
      throw this.versionConflict();
    }
  }

  private versionConflict(): ConflictException {
    return new ConflictException(
      'The document changed since it was loaded; reload it and try again',
    );
  }

  private toView(row: DocumentRow, document: StoredDocument): DocumentView {
    return {
      id: row.id,
      type: row.type,
      conversationId: row.conversationId,
      version: row.version,
      prompt: row.prompt,
      aiRevisions: row.aiRevisions,
      document,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
