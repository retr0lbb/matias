import { Authenticate, CurrentUser } from "@nestjs/authentication";
import {
	Body,
	Controller,
	Get,
	Header,
	Param,
	ParseUUIDPipe,
	Patch,
	StreamableFile,
} from "@nestjs/common";
import { z } from "zod/v4";
import type { User } from "../db/schemas/user.js";
import { ZodValidationPipe } from "../shared/pipes/zodValidationPipe.js";
import {
	AssessmentsService,
	type AssessmentView,
	type RenderedDocx,
	type RenderedPdf,
} from "./documents.service.js";
import { patchSchema } from "./schemas/patch.schema.js";

// The version the client last saw; a stale one is answered with 409.
const version = z.number().int().min(1);

const patchBodySchema = z.object({ version, ops: patchSchema });
type PatchBody = z.infer<typeof patchBodySchema>;

// The preview is shown inside a sandboxed iframe; this keeps it inert even if
// opened directly: no scripts, no network, only inline styles and data images.
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

function toPdfFile({ filename, pdf }: RenderedPdf): StreamableFile {
	return new StreamableFile(pdf, {
		type: "application/pdf",
		disposition: `attachment; filename="${filename}"`,
		length: pdf.length,
	});
}

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function toDocxFile({ filename, docx }: RenderedDocx): StreamableFile {
	return new StreamableFile(docx, {
		type: DOCX_TYPE,
		disposition: `attachment; filename="${filename}"`,
		length: docx.length,
	});
}

/**
 * Reading, manual editing and rendering of assessments. Creating and changing
 * them with AI happens only in the chat (`POST /ai/chat/stream`).
 */
@Authenticate({ verifiedEmail: true })
@Controller("documents/assessments")
export class AssessmentsController {
	constructor(private readonly assessmentsService: AssessmentsService) {}

	@Get(":id")
	get(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() user: User): Promise<AssessmentView> {
		return this.assessmentsService.get(id, user.id);
	}

	@Patch(":id")
	patch(
		@Param("id", ParseUUIDPipe) id: string,
		@Body(new ZodValidationPipe(patchBodySchema)) body: PatchBody,
		@CurrentUser() user: User,
	): Promise<AssessmentView> {
		return this.assessmentsService.patch(id, user.id, body);
	}

	@Get(":id/preview")
	@Header("Content-Type", "text/html; charset=utf-8")
	@Header("Content-Security-Policy", PREVIEW_CSP)
	@Header("Cache-Control", "no-store")
	preview(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() user: User): Promise<string> {
		return this.assessmentsService.renderPreview(id, user.id);
	}

	@Get(":id/pdf")
	async pdf(
		@Param("id", ParseUUIDPipe) id: string,
		@CurrentUser() user: User,
	): Promise<StreamableFile> {
		return toPdfFile(await this.assessmentsService.renderPdf(id, user.id));
	}

	@Get(":id/docx")
	async docx(
		@Param("id", ParseUUIDPipe) id: string,
		@CurrentUser() user: User,
	): Promise<StreamableFile> {
		return toDocxFile(await this.assessmentsService.renderDocx(id, user.id));
	}

	@Get(":id/answer-key")
	async answerKey(
		@Param("id", ParseUUIDPipe) id: string,
		@CurrentUser() user: User,
	): Promise<StreamableFile> {
		return toPdfFile(await this.assessmentsService.renderAnswerKeyPdf(id, user.id));
	}

	@Get(":id/answer-key/preview")
	@Header("Content-Type", "text/html; charset=utf-8")
	@Header("Content-Security-Policy", PREVIEW_CSP)
	@Header("Cache-Control", "no-store")
	answerKeyPreview(
		@Param("id", ParseUUIDPipe) id: string,
		@CurrentUser() user: User,
	): Promise<string> {
		return this.assessmentsService.renderAnswerKeyPreview(id, user.id);
	}
}
