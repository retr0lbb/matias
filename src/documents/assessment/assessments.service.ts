import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  assessmentsTable,
  type Assessment,
} from '../../db/schemas/assessment.js';
import { conversationsTable } from '../../db/schemas/conversation.js';
import { UsageService, type UsageSubject } from '../../usage/usage.service.js';
import { AssessmentAiService } from './ai/assessment-ai.service.js';
import { assignIds } from './build/assign-ids.js';
import { PdfRendererService } from './pdf/pdf-renderer.service.js';
import { renderAnswerKey } from './render/render-answer-key.js';
import { renderAssessmentHtml } from './render/render-html.js';
import {
  ASSESSMENT_SCHEMA_VERSION,
  assessmentDocumentSchema,
  type AssessmentDocument,
} from './schemas/document.schema.js';
import type { AssessmentHeader } from './schemas/header.schema.js';
import type { AssessmentTheme } from './schemas/theme.schema.js';

export interface GenerateAssessmentInput {
  prompt: string;
  conversationId?: string;
  header?: AssessmentHeader;
  theme?: AssessmentTheme;
}

export interface AssessmentView {
  id: string;
  conversationId: string | null;
  version: number;
  document: AssessmentDocument;
  createdAt: Date;
  updatedAt: Date;
}

export interface RenderedPdf {
  filename: string;
  pdf: Buffer;
}

const FALLBACK_FILENAME = 'avaliacao';
const COMBINING_MARKS = /[̀-ͯ]/g;

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

  private toView(row: Assessment, document: AssessmentDocument): AssessmentView {
    return {
      id: row.id,
      conversationId: row.conversationId,
      version: row.version,
      document,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
