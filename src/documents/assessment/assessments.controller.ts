import { Authenticate, CurrentUser } from '@nestjs/authentication';
import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { z } from 'zod/v4';
import type { User } from '../../db/schemas/user.js';
import { ZodValidationPipe } from '../../shared/pipes/zodValidationPipe.js';
import {
  AssessmentsService,
  type AssessmentView,
  type RenderedPdf,
} from './assessments.service.js';
import { headerSchema } from './schemas/header.schema.js';
import { themeSchema } from './schemas/theme.schema.js';

const MAX_PROMPT_LENGTH = 4000;

const generateBodySchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  conversationId: z.uuid().optional(),
  // Set by the teacher, never by the AI. Both fall back to the defaults.
  header: headerSchema.optional(),
  theme: themeSchema.optional(),
});

type GenerateBody = z.infer<typeof generateBodySchema>;

// The preview is shown inside a sandboxed iframe; this keeps it inert even if
// opened directly: no scripts, no network, only inline styles and data images.
const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

function toPdfFile({ filename, pdf }: RenderedPdf): StreamableFile {
  return new StreamableFile(pdf, {
    type: 'application/pdf',
    disposition: `attachment; filename="${filename}"`,
    length: pdf.length,
  });
}

@Authenticate({ verifiedEmail: true })
@Controller('documents/assessments')
export class AssessmentsController {
  constructor(private readonly assessmentsService: AssessmentsService) {}

  @Post()
  generate(
    @Body(new ZodValidationPipe(generateBodySchema)) body: GenerateBody,
    @CurrentUser() user: User,
  ): Promise<AssessmentView> {
    return this.assessmentsService.generate(user, body);
  }

  @Get(':id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ): Promise<AssessmentView> {
    return this.assessmentsService.get(id, user.id);
  }

  @Get(':id/preview')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', PREVIEW_CSP)
  @Header('Cache-Control', 'no-store')
  preview(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ): Promise<string> {
    return this.assessmentsService.renderPreview(id, user.id);
  }

  @Get(':id/pdf')
  async pdf(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ): Promise<StreamableFile> {
    return toPdfFile(await this.assessmentsService.renderPdf(id, user.id));
  }

  @Get(':id/answer-key')
  async answerKey(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ): Promise<StreamableFile> {
    return toPdfFile(
      await this.assessmentsService.renderAnswerKeyPdf(id, user.id),
    );
  }

  @Get(':id/answer-key/preview')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', PREVIEW_CSP)
  @Header('Cache-Control', 'no-store')
  answerKeyPreview(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ): Promise<string> {
    return this.assessmentsService.renderAnswerKeyPreview(id, user.id);
  }
}
