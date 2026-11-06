import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { Authenticate, CurrentUser } from "@nestjs/authentication";
import { FileInterceptor, FilesInterceptor } from "@nestjs/platform-express";
import { mkdirSync } from "node:fs";
import { type User } from "../db/schemas/user.js";
import { RagDocumentsService } from "./rag-documents.service.js";
import { RAG_TEMP_DIR as TEMP_DIR } from "./rag.constants.js";
import { MAX_FILE_BYTES_ANY_PLAN } from "../usage/plans.js";

mkdirSync(TEMP_DIR, { recursive: true });

// Hard ceiling for multer; the per-plan limit is enforced by UsageService.
const SINGLE_MAX_BYTES = MAX_FILE_BYTES_ANY_PLAN;
const BATCH_MAX_BYTES = 20 * 1024 * 1024;
const BATCH_MAX_FILES = 10;

@Authenticate({ verifiedEmail: true })
@Controller("rag/documents")
export class RagDocumentsController {
  constructor(private readonly documentsService: RagDocumentsService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor("file", {
      dest: TEMP_DIR,
      limits: { fileSize: SINGLE_MAX_BYTES },
    }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: User,
    @Query("conversationId") queryConversationId?: string,
    @Body("conversationId") bodyConversationId?: string,
  ) {
    const conversationId =
      queryConversationId || bodyConversationId || undefined;
    return this.documentsService.uploadOne(file, user, conversationId);
  }

  @Post("batch")
  @UseInterceptors(
    FilesInterceptor("files", BATCH_MAX_FILES, {
      dest: TEMP_DIR,
      limits: { fileSize: BATCH_MAX_BYTES },
    }),
  )
  uploadMany(
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @CurrentUser() user: User,
    @Query("conversationId") queryConversationId?: string,
    @Body("conversationId") bodyConversationId?: string,
  ) {
    const conversationId =
      queryConversationId || bodyConversationId || undefined;
    if (!files || files.length === 0) {
      throw new BadRequestException("At least one file is required");
    }

    return this.documentsService.uploadMany(files, user, conversationId);
  }

  @Get(":id")
  status(@Param("id") id: string, @CurrentUser() user: User) {
    return this.documentsService.getStatus(id, user.id);
  }
}
