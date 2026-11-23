import { Authenticate, CurrentUser } from "@nestjs/authentication";
import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Logger,
	Param,
	Patch,
	Post,
	Query,
	Res,
} from "@nestjs/common";
import type { Response } from "express";
import type { User } from "../db/schemas/user.js";
import { ZodValidationPipe } from "../shared/pipes/zodValidationPipe.js";
import { AiService } from "./ai.service.js";
import { ChatHistoryService } from "./chat-history.service.js";
import { type ChatBody, chatBodySchema } from "./dto/chat-body.dto.js";
import type { ChatDetail } from "./dto/chat-detail.dto.js";
import {
	type ChatListItem,
	type ChatListPage,
	type GetChatsDto,
	getChatsDtoSchema,
} from "./dto/get-chats.dto.js";
import { type RenameChatDto, renameChatSchema } from "./dto/rename-chat.dto.js";

@Controller("ai/chat")
export class AiController {
	private readonly logger = new Logger(AiController.name);

	constructor(
		private readonly aiService: AiService,
		private readonly chatHistory: ChatHistoryService,
	) {}

	@Authenticate({ verifiedEmail: true })
	@Post("stream")
	async chatStream(
		@Body(new ZodValidationPipe(chatBodySchema)) body: ChatBody,
		@CurrentUser() user: User,
		@Query("conversationId") conversationId: string | undefined,
		@Res() res: Response,
	): Promise<void> {
		// Runs before any SSE header is sent, so auth/validation/permission
		// errors still reach the client as normal HTTP statuses.
		const ctx = await this.aiService.prepareStream(body.prompt, user.id, conversationId, body);

		const abort = new AbortController();
		res.on("close", () => {
			if (!res.writableEnded) {
				abort.abort();
			}
		});

		res.status(200).set({
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.flushHeaders();

		try {
			for await (const event of this.aiService.streamAnswer(ctx, abort.signal)) {
				if (abort.signal.aborted) {
					continue;
				}
				res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
			}
		} catch (error) {
			this.logger.error("[STREAM] unexpected failure", error);
			if (!abort.signal.aborted) {
				res.write(`event: error\ndata: ${JSON.stringify({ message: "Generation failed" })}\n\n`);
			}
		} finally {
			res.end();
		}
	}

	/** `?limit=30&cursor=<nextCursor>` → `{ items, nextCursor }`, most recently active first. */
	@Get("")
	@Authenticate()
	async getAllChats(
		@Query(new ZodValidationPipe(getChatsDtoSchema)) query: GetChatsDto,
		@CurrentUser() user: User,
	): Promise<ChatListPage> {
		return await this.chatHistory.list(user.id, query);
	}

	/** 404 when the chat is missing or belongs to someone else. */
	@Get("/:conversationId")
	@Authenticate()
	async getChat(
		@Param("conversationId") convId: string,
		@CurrentUser() user: User,
	): Promise<ChatDetail> {
		return await this.chatHistory.get(convId, user.id);
	}

	/** `?deleteDocuments=true` (or `{ deleteDocuments: true }` in the body) also deletes the chat's documents. */
	@Authenticate()
	@Delete("/:conversationId")
	@HttpCode(204)
	async deleteConversation(
		@Param("conversationId") convId: string,
		@CurrentUser() user: User,
		@Query("deleteDocuments") deleteDocumentsQuery: string | undefined,
		@Body() body: { deleteDocuments?: unknown } | undefined,
	): Promise<void> {
		const deleteDocuments = deleteDocumentsQuery === "true" || body?.deleteDocuments === true;
		await this.chatHistory.delete(convId, user.id, deleteDocuments);
	}

	@Authenticate()
	@Patch("/:conversationId")
	async renameConversation(
		@Param("conversationId") convId: string,
		@CurrentUser() user: User,
		@Body(new ZodValidationPipe(renameChatSchema)) body: RenameChatDto,
	): Promise<ChatListItem> {
		return await this.chatHistory.rename(convId, user.id, body.title);
	}
}
