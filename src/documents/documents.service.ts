import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
  type Assessment,
  assessmentsTable,
} from '../../db/schemas/assessment.js';
import { conversationsTable } from '../../db/schemas/conversation.js';
import { UsageService, type UsageSubject } from '../../usage/usage.service.js';
import { AssessmentAiService } from './ai/assessment-ai.service.js';
import { assignIds } from './build/assign-ids.js';
import { applyPatch } from './patch/apply-patch.js';
import { PdfRendererService } from './pdf/pdf-renderer.service.js';
import { renderAnswerKey } from './render/render-answer-key.js';
import { renderAssessmentHtml } from './render/render-html.js';
import {
  ASSESSMENT_SCHEMA_VERSION,
  type AssessmentDocument,
  assessmentDocumentSchema,
} from './schemas/document.schema.js';
import type { AssessmentHeader } from './schemas/header.schema.js';
import type { AssessmentPatch } from './schemas/patch.schema.js';
import type { AssessmentTheme } from './schemas/theme.schema.js';

export interface GenerateAssessmentInput {
  prompt: string;
  conversationId?: string;
  header?: AssessmentHeader;
  theme?: AssessmentTheme;
}

export interface PatchAssessmentInput {
  version: number;
  ops: AssessmentPatch;
}

export interface ReviseAssessmentInput {
  version: number;
  instruction: string;
}

export interface RegenerateAssessmentInput {
  version: number;
  /** Falls back to the request the assessment was last generated from. */
  prompt?: string;
}

export interface AssessmentView {
  id: string;
  conversationId: string | null;
  /** Send it back with every change; a stale value is answered with 409. */
  version: number;
  prompt: string | null;
  aiRevisions: number;
  document: AssessmentDocument;
  createdAt: Date;
  updatedAt: Date;
}

export interface RenderedPdf {
  filename: string;
  pdf: Buffer;
}

const FALLBACK_FILENAME = 'avaliacao';
const COMBINING_MARKS = /\p{M}/gu;

/** ASCII-only name, safe to put in a Content-Disposition header. */
function toFilename(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return slug || FALLBACK_FILENAME;
}

@Injectable()
export class AssessmentsService {
  private readonly logger = new Logger(AssessmentsService.name);

  constructor(
    @InjectDrizzle() private readonly db: NodePgDatabase,
    private readonly assessmentAi: AssessmentAiService,
    private readonly pdfRenderer: PdfRendererService,
    private readonly usageService: UsageService,
  ) {}

  async generate(
    user: UsageSubject,
    input: GenerateAssessmentInput,
  ): Promise<AssessmentView> {
    await this.assertConversationAccess(user.id, input.conversationId);
    // Fail before paying for the AI call; checked again under lock on insert.
    await this.usageService.assertCanCreateAssessment(this.db, user);

    const generated = await this.assessmentAi.generate(input.prompt);

    const document = assessmentDocumentSchema.parse({
      schemaVersion: ASSESSMENT_SCHEMA_VERSION,
      content: assignIds(generated),
      header: input.header ?? {},
      theme: input.theme ?? {},
    });

    const row = await this.db.transaction(async (tx) => {
      await this.usageService.lockUser(tx, user.id);
      await this.usageService.assertCanCreateAssessment(tx, user);

      const [inserted] = await tx
        .insert(assessmentsTable)
        .values({
          userId: user.id,
          conversationId: input.conversationId ?? null,
          document,
          prompt: input.prompt,
        })
        .returning();

      return inserted;
    });

    return this.toView(row, document);
  }

  async get(id: string, userId: string): Promise<AssessmentView> {
    const [row] = await this.db
      .select()
      .from(assessmentsTable)
      .where(
        and(eq(assessmentsTable.id, id), eq(assessmentsTable.userId, userId)),
      );

    // Same answer for "does not exist" and "belongs to someone else".
    if (!row) {
      throw new NotFoundException('Assessment not found');
    }

    const parsed = assessmentDocumentSchema.safeParse(row.document);
    if (!parsed.success) {
      this.logger.error(
        `Stored assessment ${id} no longer matches the schema: ${parsed.error.message}`,
      );
      throw new InternalServerErrorException('Assessment could not be read');
    }

    return this.toView(row, parsed.data);
  }

  /** Manual change: no AI, no quota. */
  async patch(
    id: string,
    userId: string,
    input: PatchAssessmentInput,
  ): Promise<AssessmentView> {
    const current = await this.get(id, userId);
    this.assertVersion(current, input.version);

    const result = applyPatch(current.document, input.ops);
    if (!result.success) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'The patch could not be applied',
        errors: result.errors,
      });
    }

    const [row] = await this.db
      .update(assessmentsTable)
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
    input: ReviseAssessmentInput,
  ): Promise<AssessmentView> {
    const current = await this.get(id, user.id);
    this.assertVersion(current, input.version);
    await this.usageService.assertCanReviseAssessment(
      this.db,
      user,
      current.aiRevisions,
    );

    const document = await this.assessmentAi.revise(
      current.document,
      input.instruction,
    );

    return this.saveAiRevision(current, user, { document });
  }

  /** New content from the prompt; header and theme are kept. */
  async regenerate(
    id: string,
    user: UsageSubject,
    input: RegenerateAssessmentInput,
  ): Promise<AssessmentView> {
    const current = await this.get(id, user.id);
    this.assertVersion(current, input.version);

    const prompt = input.prompt ?? current.prompt;
    if (!prompt) {
      throw new BadRequestException('A prompt is required');
    }

    await this.usageService.assertCanReviseAssessment(
      this.db,
      user,
      current.aiRevisions,
    );

    const generated = await this.assessmentAi.generate(prompt);

    const document = assessmentDocumentSchema.parse({
      ...current.document,
      content: assignIds(generated),
    });

    return this.saveAiRevision(current, user, { document, prompt });
  }

  async renderPreview(id: string, userId: string): Promise<string> {
    const { document } = await this.get(id, userId);
    return renderAssessmentHtml(
      document.content,
      document.header,
      document.theme,
    );
  }

  async renderPdf(id: string, userId: string): Promise<RenderedPdf> {
    const { document } = await this.get(id, userId);
    const html = renderAssessmentHtml(
      document.content,
      document.header,
      document.theme,
    );

    return {
      filename: `${toFilename(document.content.title)}.pdf`,
      pdf: await this.pdfRenderer.render(html),
    };
  }

  async renderAnswerKeyPreview(id: string, userId: string): Promise<string> {
    const { document } = await this.get(id, userId);
    return renderAnswerKey(document.content, document.theme);
  }

  async renderAnswerKeyPdf(id: string, userId: string): Promise<RenderedPdf> {
    const { document } = await this.get(id, userId);
    const html = renderAnswerKey(document.content, document.theme);

    return {
      filename: `${toFilename(document.content.title)}-gabarito.pdf`,
      pdf: await this.pdfRenderer.render(html),
    };
  }

  // The conversation may not exist yet (clients can pre-generate its id), but
  // an existing one must belong to the caller.
  private async assertConversationAccess(
    userId: string,
    conversationId: string | undefined,
  ): Promise<void> {
    if (!conversationId) {
      return;
    }

    const [conversation] = await this.db
      .select({ userId: conversationsTable.userId })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId));

    if (conversation && conversation.userId !== userId) {
      throw new ForbiddenException('Conversation belongs to another user');
    }
  }

  // Quota is re-checked under the per-user lock, and the write only lands if
  // nobody changed the assessment while the AI was working.
  private async saveAiRevision(
    current: AssessmentView,
    user: UsageSubject,
    changes: { document: AssessmentDocument; prompt?: string },
  ): Promise<AssessmentView> {
    const row = await this.db.transaction(async (tx) => {
      await this.usageService.lockUser(tx, user.id);
      await this.usageService.assertCanReviseAssessment(
        tx,
        user,
        current.aiRevisions,
      );

      const [updated] = await tx
        .update(assessmentsTable)
        .set({
          ...changes,
          version: current.version + 1,
          aiRevisions: sql`${assessmentsTable.aiRevisions} + 1`,
        })
        .where(this.atVersion(current, user.id))
        .returning();

      return updated;
    });

    if (!row) {
      throw this.versionConflict();
    }

    return this.toView(row, changes.document);
  }

  private atVersion(current: AssessmentView, userId: string) {
    return and(
      eq(assessmentsTable.id, current.id),
      eq(assessmentsTable.userId, userId),
      eq(assessmentsTable.version, current.version),
    );
  }

  private assertVersion(current: AssessmentView, version: number): void {
    if (current.version !== version) {
      throw this.versionConflict();
    }
  }

  private versionConflict(): ConflictException {
    return new ConflictException(
      'The assessment changed since it was loaded; reload it and try again',
    );
  }

  private toView(row: Assessment, document: AssessmentDocument): AssessmentView {
    return {
      id: row.id,
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
