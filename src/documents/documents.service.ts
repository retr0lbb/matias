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
import { and, eq, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  type DocumentRow,
  documentsTable,
} from '../db/schemas/document.js';
import {
  type ConversationRef,
  ConversationContextService,
  type RecordedTurn,
} from '../conversation/conversation-context.service.js';
import type { ThinkingLevelOption } from '../usage/plan-limits.js';
import {
  type DbExecutor,
  type DocumentAllowance,
  UsageService,
  type UsageSubject,
} from '../usage/usage.service.js';
import { isScoredBlock } from './blocks/registry.js';
import {
  type DocumentContext,
  DocumentAiService,
  NO_CONTEXT,
} from './ai/document-ai.service.js';
import { assignIds } from './build/assign-ids.js';
import { applyPatch } from './patch/apply-patch.js';
import { PdfRendererService } from './pdf/pdf-renderer.service.js';
import { renderAnswerKey } from './render/render-answer-key.js';
import { formatPoints } from './render/format.js';
import { totalPoints } from './render/layout.js';
import { renderDocumentHtml } from './render/render-html.js';
import {
  DOCUMENT_SCHEMA_VERSION,
  type StoredDocument,
  upgradeDocument,
} from './schemas/document.schema.js';
import type { DocumentHeader } from './schemas/header.schema.js';
import type { DocumentPatch } from './schemas/patch.schema.js';
import type { DocumentTheme } from './schemas/theme.schema.js';
import type { DocumentContent } from './schemas/content.schema.js';
import type { DocumentType } from './types/document-type.js';
import { getDocumentType } from './types/registry.js';

export interface GenerateDocumentInput {
  type: DocumentType;
  prompt: string;
  conversationId?: string;
  header?: DocumentHeader;
  theme?: DocumentTheme;
  /** Must be within the plan's max thinking level (403 otherwise). */
  thinkingLevel: ThinkingLevelOption;
}

export interface PatchDocumentInput {
  version: number;
  ops: DocumentPatch;
}

export interface ReviseDocumentInput {
  version: number;
  instruction: string;
  thinkingLevel: ThinkingLevelOption;
}

export interface RegenerateDocumentInput {
  version: number;
  /** Falls back to the request the document was last generated from. */
  prompt?: string;
  thinkingLevel: ThinkingLevelOption;
  /**
   * Off (default): the conversation is read as it was when the document was
   * created, so a regenerate stays about the same thing. On: as it is now.
   */
  refreshContext?: boolean;
}

export interface DocumentView {
  id: string;
  type: DocumentType;
  conversationId: string | null;
  /** Send it back with every change; a stale value is answered with 409. */
  version: number;
  prompt: string | null;
  aiRevisions: number;
  document: StoredDocument;
  createdAt: Date;
  updatedAt: Date;
}

export interface RenderedPdf {
  filename: string;
  pdf: Buffer;
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

// Context limits (see specs/document-blocks.md, Phase 3).
const HISTORY_LIMIT = 20;
const MAX_CHARS_PER_MESSAGE = 6000;
const MAX_HISTORY_CHARS = 40_000;
const CHUNK_LIMIT = 12;
const MAX_CHUNK_CHARS = 24_000;
const MAX_QUERY_CHARS = 1000;

/** «Título» (10 questões, 10 pontos): how the chat describes a document. */
function describe(content: DocumentContent): string {
  const questions = content.sections.flatMap((section) => section.blocks).filter(isScoredBlock).length;
  const total = totalPoints(content);
  const details = [
    questions > 0 ? `${questions} ${questions === 1 ? 'questão' : 'questões'}` : null,
    total > 0 ? formatPoints(total) : null,
  ].filter(Boolean);

  return `«${content.title}»${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

/** "a avaliação" → "da avaliação", "o plano de aula" → "do plano de aula". */
function ofLabel(chatLabel: string): string {
  return chatLabel.replace(/^a /, 'da ').replace(/^o /, 'do ');
}

function needsClarification(question: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    code: 'NEEDS_CLARIFICATION',
    message: question,
    question,
  });
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @InjectDrizzle() private readonly db: NodePgDatabase,
    private readonly documentAi: DocumentAiService,
    private readonly pdfRenderer: PdfRendererService,
    private readonly usageService: UsageService,
    private readonly conversations: ConversationContextService,
  ) {}

  async generate(
    user: UsageSubject,
    input: GenerateDocumentInput,
  ): Promise<DocumentView> {
    const type = getDocumentType(input.type);
    // Fail before paying for the AI call (or creating a conversation); checked again under lock on insert.
    const allowance = await this.usageService.getDocumentAllowance(this.db, user);
    this.usageService.assertThinkingLevelAllowed(allowance, input.thinkingLevel);
    this.usageService.assertCanSpendDocumentCredit(allowance, 'GENERATE');

    const conversation = input.conversationId
      ? await this.conversations.getOrCreate(user.id, input.conversationId)
      : null;
    const context = conversation
      ? await this.loadContext(user.id, conversation, input.prompt)
      : NO_CONTEXT;

    const generated = await this.documentAi.generate(type, input.prompt, context, input.thinkingLevel);
    if (generated.kind === 'clarification') {
      // Nothing is stored and no credit is spent: the teacher answers and asks again.
      throw needsClarification(generated.question);
    }

    const document = type.schemas.document.parse({
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      content: assignIds(generated.content),
      header: input.header ?? {},
      theme: input.theme ?? {},
    });
    // One clock for the row and its chat messages, so regenerate's "as it was" cut-off is exact.
    const createdAt = new Date();

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
          conversationId: conversation?.id ?? null,
          document,
          prompt: input.prompt,
          createdAt,
        })
        .returning();

      await this.usageService.recordDocumentCredit(tx, {
        userId: user.id,
        documentId: inserted.id,
        reason: 'GENERATE',
      });

      if (conversation) {
        await this.conversations.recordTurn(tx, {
          conversationId: conversation.id,
          userContent: input.prompt,
          iaContent: `Criei ${type.chatLabel} ${describe(document.content)}.`,
          metadata: { documentId: inserted.id, documentType: type.type },
          title: document.content.title,
          at: createdAt,
        });
      }

      return inserted;
    });

    return this.toView(row, document);
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

  /** The AI turns the instruction into a patch; same engine as `patch`. */
  async revise(
    id: string,
    user: UsageSubject,
    input: ReviseDocumentInput,
  ): Promise<DocumentView> {
    const current = await this.get(id, user.id);
    this.assertVersion(current, input.version);
    await this.assertCanChangeWithAi(this.db, user, current, input.thinkingLevel);

    // Edits are not written to the chat: ten small ones would push the real conversation out.
    const conversation = await this.ownedConversation(user.id, current.conversationId);
    const context = conversation
      ? await this.loadContext(user.id, conversation, input.instruction)
      : NO_CONTEXT;

    const document = await this.documentAi.revise(
      getDocumentType(current.type),
      current.document,
      input.instruction,
      context,
      input.thinkingLevel,
    );

    return this.saveAiRevision(current, user, { document });
  }

  /** New content from the prompt; header and theme are kept. */
  async regenerate(
    id: string,
    user: UsageSubject,
    input: RegenerateDocumentInput,
  ): Promise<DocumentView> {
    const current = await this.get(id, user.id);
    this.assertVersion(current, input.version);

    const prompt = input.prompt ?? current.prompt;
    if (!prompt) {
      throw new BadRequestException('A prompt is required');
    }

    await this.assertCanChangeWithAi(this.db, user, current, input.thinkingLevel);

    const type = getDocumentType(current.type);
    const conversation = await this.ownedConversation(user.id, current.conversationId);
    const context = conversation
      ? await this.loadContext(
          user.id,
          conversation,
          prompt,
          input.refreshContext ? undefined : current.createdAt,
        )
      : NO_CONTEXT;

    const generated = await this.documentAi.generate(type, prompt, context, input.thinkingLevel);
    if (generated.kind === 'clarification') {
      throw needsClarification(generated.question);
    }

    const document = type.schemas.document.parse({
      ...current.document,
      content: assignIds(generated.content),
    });

    const turn: RecordedTurn | undefined = conversation
      ? {
          conversationId: conversation.id,
          userContent: input.prompt ?? `Gere novamente «${current.document.content.title}».`,
          iaContent: `Gerei uma nova versão ${ofLabel(type.chatLabel)} ${describe(document.content)}.`,
          metadata: { documentId: current.id, documentType: type.type },
          title: document.content.title,
        }
      : undefined;

    return this.saveAiRevision(current, user, { document, prompt }, turn);
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

  /** The document's conversation, if it still exists and is the user's. */
  private async ownedConversation(
    userId: string,
    conversationId: string | null,
  ): Promise<ConversationRef | null> {
    return conversationId ? this.conversations.findOwned(userId, conversationId) : null;
  }

  /**
   * The history the request may refer to and the documents retrieved for it.
   * `before` reads the conversation as it was at that moment.
   */
  private async loadContext(
    userId: string,
    conversation: ConversationRef,
    request: string,
    before?: Date,
  ): Promise<DocumentContext> {
    const history = await this.conversations.loadHistory(conversation.id, {
      limit: HISTORY_LIMIT,
      before,
      completedOnly: true,
      maxCharsPerMessage: MAX_CHARS_PER_MESSAGE,
      maxTotalChars: MAX_HISTORY_CHARS,
    });

    // "Based on the conversation" alone is a useless embedding query: add what it points at.
    const recentRequests = history
      .filter(({ role }) => role === 'USER')
      .slice(-2)
      .reverse()
      .map(({ content }) => content ?? '');
    const query = [request, ...recentRequests, conversation.title ?? '']
      .filter((part) => part.trim().length > 0)
      .join('\n')
      .slice(0, MAX_QUERY_CHARS);

    const chunks = await this.conversations.retrieve({
      query,
      userId,
      conversationId: conversation.id,
      limit: CHUNK_LIMIT,
      maxChars: MAX_CHUNK_CHARS,
    });

    return { history, chunks };
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
    turn?: RecordedTurn,
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

      if (updated && turn) {
        await this.conversations.recordTurn(tx, turn);
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
