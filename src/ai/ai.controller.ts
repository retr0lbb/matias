import { Authenticate, CurrentUser } from "@nestjs/authentication";
import { Body, Controller, Logger, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import type { User } from "../db/schemas/user.js";
import { ZodValidationPipe } from "../shared/pipes/zodValidationPipe.js";
import { AiService } from "./ai.service.js";
import { type ChatBody, chatBodySchema } from "./dto/chat-body.dto.js";

@Controller("ai/chat")
export class AiController {
	private readonly logger = new Logger(AiController.name);

	constructor(private readonly aiService: AiService) {}

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
}
