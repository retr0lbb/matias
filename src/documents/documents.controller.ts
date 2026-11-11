import { Authenticate, CurrentUser } from '@nestjs/authentication';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { patchSchema } from './schemas/patch.schema.js';
import { themeSchema } from './schemas/theme.schema.js';

const MAX_PROMPT_LENGTH = 4000;
const MAX_INSTRUCTION_LENGTH = 2000;

const prompt = z.string().trim().min(1).max(MAX_PROMPT_LENGTH);
// The version the client last saw; a stale one is answered with 409.
const version = z.number().int().min(1);

const generateBodySchema = z.object({
  prompt,
  conversationId: z.uuid().optional(),
  // Set by the teacher, never by the AI. Both fall back to the defaults.
  header: headerSchema.optional(),
  theme: themeSchema.optional(),
});

type GenerateBody = z.infer<typeof generateBodySchema>;

const patchBodySchema = z.object({ version, ops: patchSchema });
type PatchBody = z.infer<typeof patchBodySchema>;

const reviseBodySchema = z.object({
  version,
  instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_LENGTH),
});
type ReviseBody = z.infer<typeof reviseBodySchema>;

const regenerateBodySchema = z.object({ version, prompt: prompt.optional() });
type RegenerateBody = z.infer<typeof regenerateBodySchema>;

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

  @Patch(':id')
  patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(patchBodySchema)) body: PatchBody,
    @CurrentUser() user: User,
  ): Promise<AssessmentView> {
    return this.assessmentsService.patch(id, user.id, body);
  }

  @Post(':id/revise')
  @HttpCode(200)
  revise(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reviseBodySchema)) body: ReviseBody,
    @CurrentUser() user: User,
  ): Promise<AssessmentView> {
    return this.assessmentsService.revise(id, user, body);
  }

  @Post(':id/regenerate')
  @HttpCode(200)
  regenerate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(regenerateBodySchema)) body: RegenerateBody,
    @CurrentUser() user: User,
  ): Promise<AssessmentView> {
    return this.assessmentsService.regenerate(id, user, body);
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
