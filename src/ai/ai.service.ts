import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { eq } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { conversationsTable } from "../db/schemas/conversation.js";
import { type MessageMetadata, messagesTable } from "../db/schemas/message.js";
import { userTable } from "../db/schemas/user.js";
import { ConversationContextService } from "../conversation/conversation-context.service.js";
import type { RagSearchResult } from "../rag/rag.service.js";
import {
	type QuotaExceededBody,
	QuotaExceededException,
} from "../usage/quota-exceeded.exception.js";
import type { ThinkingLevelOption } from "../usage/plan-limits.js";
import { type ChatAllowance, UsageService } from "../usage/usage.service.js";
import { AIExpense, AiExpensesFactory } from "./ai.factory.js";
import type { AIResponse } from "./ai-provider.type.js";
import type { ChatOptions } from "./dto/chat-body.dto.js";
import type { ChatStreamEvent, ModelSelection } from "./dto/chat-stream-event.js";
import { type JudgeClassification, JudgeModel } from "./models/judge-model.js";

const HISTORY_LIMIT = 20;

type History = { role: "USER" | "IA"; content: string | null }[];

export interface ChatStreamContext {
	user: typeof userTable.$inferSelect;
	prompt: string;
	conversation: { id: string; title: string | null };
	/** RAG only runs when the client sent a conversationId (same rule as chat()). */
	ragEnabled: boolean;
	options: ChatOptions;
	/** Plan limits and usage, loaded (and checked for MANUAL picks) before the stream starts. */
	allowance: ChatAllowance;
}

/** Which model and thinking level a turn runs with, and why. */
interface Turn {
	model: AIExpense;
	selection: ModelSelection;
	downgradedFrom?: AIExpense;
	thinkingLevel: ThinkingLevelOption;
	judge: JudgeClassification;
}

@Injectable()
export class AiService {
	private readonly logger = new Logger(AiService.name);

	constructor(
		private readonly aiFactory: AiExpensesFactory,
		@InjectDrizzle() private readonly db: NodePgDatabase,
		private readonly conversations: ConversationContextService,
		private readonly usageService: UsageService,
		private readonly judgeModel: JudgeModel,
	) {}

	async chat(
		prompt: string,
		loggedUser: string,
		conversationId: string | undefined,
		options: ChatOptions,
	) {
		const [user] = await this.db.select().from(userTable).where(eq(userTable.id, loggedUser));

		if (!user) {
			throw new UnauthorizedException("User not authenticated properly");
		}

		const allowance = await this.loadAllowance(user, options);

		const conversation = await this.conversations.getOrCreate(loggedUser, conversationId);
		const history = await this.conversations.loadHistory(conversation.id, { limit: HISTORY_LIMIT });

		const turn = await this.planTurn(prompt, history, options, allowance);
		const judgeResponse = turn.judge;

		if (judgeResponse.title && !conversation.title) {
			await this.db
				.update(conversationsTable)
				.set({ title: judgeResponse.title })
				.where(eq(conversationsTable.id, conversation.id));

			conversation.title = judgeResponse.title;
		}

		const chunks: RagSearchResult[] =
			judgeResponse.retrieve && conversationId
				? await this.conversations.retrieve({
						query: prompt,
						userId: loggedUser,
						conversationId: conversation.id,
					})
				: [];

		const input = buildRagPrompt(prompt, chunks, history);

		await this.db.insert(messagesTable).values({
			conversationId: conversation.id,
			role: "USER",
			content: prompt,
		});

		const provider = this.aiFactory.create(turn.model);

		this.logger.log(`[RAG] retrieve=${judgeResponse.retrieve} conversationId=${conversationId}`);
		const message = await provider.generate({
			message: input,
			thinkingLevel: turn.thinkingLevel,
			prompt: {
				needRetrieval: judgeResponse.retrieve,
				needTools: false, // hard coded false
				tier: turn.model,
				userInfo: user,
				needDocumentGeneration: false,
			},
		});

		await this.db.insert(messagesTable).values({
			conversationId: conversation.id,
			role: "IA",
			content: message.output_text,
			inputTokens: message.tokens.prompt,
			outputTokens: message.tokens.output + message.tokens.thoughts,
			interactionId: message.messageId,
			expense: turn.model,
			metadata: this.buildMetadata(turn, message),
		});

		return message.output_text;
	}

	async prepareStream(
		prompt: string,
		loggedUser: string,
		conversationId: string | undefined,
		options: ChatOptions,
	): Promise<ChatStreamContext> {
		const [user] = await this.db.select().from(userTable).where(eq(userTable.id, loggedUser));

		if (!user) {
			throw new UnauthorizedException("User not authenticated properly");
		}

		// Before any SSE header: a MANUAL pick over quota is a real HTTP 429.
		const allowance = await this.loadAllowance(user, options);

		const conversation = await this.conversations.getOrCreate(loggedUser, conversationId);

		return {
			user,
			prompt,
			conversation: { id: conversation.id, title: conversation.title },
			ragEnabled: Boolean(conversationId),
			options,
			allowance,
		};
	}

	/**
	 * Streams the answer for a prepared chat. Never throws: failures become an
	 * `error` event. The IA message is saved when the stream ends, with partial
	 * text if the client aborted (FAILED) or generation broke (ERROR).
	 */
	async *streamAnswer(
		ctx: ChatStreamContext,
		signal: AbortSignal,
	): AsyncGenerator<ChatStreamEvent> {
		let partial = "";
		let partialThinking = "";
		let final: AIResponse | undefined;
		let turn: Turn | undefined;
		let status: "COMPLETED" | "FAILED" | "ERROR" = "FAILED";

		yield {
			type: "start",
			data: { conversationId: ctx.conversation.id, title: ctx.conversation.title },
		};

		try {
			yield { type: "status", data: { stage: "classifying" } };

			const history = await this.conversations.loadHistory(ctx.conversation.id, {
				limit: HISTORY_LIMIT,
			});

			turn = await this.planTurn(ctx.prompt, history, ctx.options, ctx.allowance);
			const judgeResponse = turn.judge;

			if (judgeResponse.title && !ctx.conversation.title) {
				await this.db
					.update(conversationsTable)
					.set({ title: judgeResponse.title })
					.where(eq(conversationsTable.id, ctx.conversation.id));

				ctx.conversation.title = judgeResponse.title;
			}

			let chunks: RagSearchResult[] = [];
			if (judgeResponse.retrieve && ctx.ragEnabled) {
				yield { type: "status", data: { stage: "retrieving" } };
				chunks = await this.conversations.retrieve({
					query: ctx.prompt,
					userId: ctx.user.id,
					conversationId: ctx.conversation.id,
				});
			}

			const input = buildRagPrompt(ctx.prompt, chunks, history);

			await this.db.insert(messagesTable).values({
				conversationId: ctx.conversation.id,
				role: "USER",
				content: ctx.prompt,
			});

			const provider = this.aiFactory.create(turn.model);

			yield {
				type: "status",
				data: {
					stage: "generating",
					model: turn.model,
					title: ctx.conversation.title,
					selection: turn.selection,
					thinkingLevel: turn.thinkingLevel,
					downgradedFrom: turn.downgradedFrom,
				},
			};
			for await (const chunk of provider.generateStream({
				message: input,
				signal,
				thinkingLevel: turn.thinkingLevel,
				prompt: {
					needDocumentGeneration: false,
					needRetrieval: judgeResponse.retrieve,
					needTools: false,
					tier: turn.model,
				},
			})) {
				if (chunk.type === "text") {
					partial += chunk.text;
					yield { type: "text", data: { text: chunk.text } };
				} else if (chunk.type === "thinking") {
					partialThinking += chunk.text;
					yield { type: "thinking", data: { text: chunk.text } };
				} else {
					final = chunk.response;
				}
			}

			if (final) {
				status = "COMPLETED";
				yield {
					type: "done",
					data: {
						messageId: final.messageId,
						finishReason: final.status,
						usage: final.usage,
					},
				};
			}
		} catch (error) {
			if (signal.aborted) {
				status = "FAILED";
				this.logger.warn(`[STREAM] client aborted conversation=${ctx.conversation.id}`);
			} else if (error instanceof QuotaExceededException) {
				status = "ERROR";
				yield { type: "error", data: error.getResponse() as QuotaExceededBody };
			} else {
				status = "ERROR";
				this.logger.error(`[STREAM] generation failed conversation=${ctx.conversation.id}`, error);
				yield { type: "error", data: { code: "GENERATION_FAILED", message: "Generation failed" } };
			}
		} finally {
			if (turn) {
				await this.saveStreamedMessage(
					ctx,
					turn,
					final?.output_text ?? partial,
					final,
					status,
					partialThinking,
				);
			}
		}
	}

	/**
	 * Loads limits/usage once and rejects up front (before any conversation or
	 * SSE header) a thinking level the plan doesn't include (403) or a MANUAL
	 * model with no quota left (429).
	 */
	private async loadAllowance(user: { id: string; cycleAnchorAt: Date }, options: ChatOptions) {
		const allowance = await this.usageService.getChatAllowance(user);

		// CHEAP always runs at MINIMAL, so the requested level doesn't matter there.
		if (options.model !== "CHEAP") {
			this.usageService.assertThinkingLevelAllowed(allowance, options.thinkingLevel);
		}

		if (options.model !== "AUTO") {
			this.usageService.assertCanChat(allowance, options.model);
		}

		return allowance;
	}

	/**
	 * Runs the judge and settles the model. AUTO lets the judge pick and
	 * downgrades when that tier has no quota left; MANUAL picks and the
	 * thinking level were already checked in `loadAllowance`.
	 */
	private async planTurn(
		prompt: string,
		history: History,
		options: ChatOptions,
		allowance: ChatAllowance,
	): Promise<Turn> {
		const thinking = { thinkingLevel: options.thinkingLevel };

		if (options.model !== "AUTO") {
			const judge = await this.judgeModel.classify({ prompt, history, routeModel: false });
			return { model: AIExpense[options.model], selection: "MANUAL", judge, ...thinking };
		}

		const judge = await this.judgeModel.classify({ prompt, history, routeModel: true });
		const choice = this.usageService.pickAvailableModel(allowance, judge.model);

		return {
			model: AIExpense[choice.model],
			selection: "AUTO",
			downgradedFrom: choice.downgradedFrom && AIExpense[choice.downgradedFrom],
			judge,
			...thinking,
		};
	}

	private async saveStreamedMessage(
		ctx: ChatStreamContext,
		turn: Turn,
		content: string,
		final: AIResponse | undefined,
		status: "COMPLETED" | "FAILED" | "ERROR",
		partialThinking: string,
	): Promise<void> {
		if (content.length === 0) {
			return;
		}

		try {
			await this.db.insert(messagesTable).values({
				conversationId: ctx.conversation.id,
				role: "IA",
				content,
				inputTokens: final?.tokens.prompt ?? 0,
				outputTokens: final ? final.tokens.output + final.tokens.thoughts : 0,
				interactionId: final?.messageId || null,
				expense: turn.model,
				status,
				metadata: this.buildMetadata(turn, final, partialThinking),
			});
		} catch (error) {
			this.logger.error(
				`[STREAM] failed to save IA message conversation=${ctx.conversation.id}`,
				error,
			);
		}
	}

	/**
	 * Metadata for an IA message. Without `final` (aborted/failed stream) only the
	 * turn decisions, judge usage and any partial thinking text are known.
	 */
	private buildMetadata(
		turn: Turn,
		final: AIResponse | undefined,
		partialThinking?: string,
	): MessageMetadata {
		const thinking = final?.thinking_output ?? (partialThinking || undefined);
		const decided: MessageMetadata = {
			tier: turn.model,
			selection: turn.selection,
			downgradedFrom: turn.downgradedFrom,
			thinkingOption: turn.thinkingLevel,
			judge: turn.judge.usage,
		};

		if (!final) {
			return { ...decided, thinking };
		}

		return {
			...decided,
			modelName: final.modelName,
			modelId: final.model,
			thinkingLevel: final.thinkingLevel,
			finishReason: final.status,
			latencyMs: Date.parse(final.updated) - Date.parse(final.created),
			tokens: final.tokens,
			thinking,
		};
	}
}

function buildRagPrompt(
	prompt: string,
	chunks: RagSearchResult[],
	history: Array<{ role: string; content: string | null }>,
): string {
	const sections = [
		"You are a helpful assistant. Answer the user using the context below when it is relevant. If the context does not contain the answer, say so and answer from general knowledge.",
	];

	if (chunks.length > 0) {
		sections.push(
			"Context:\n" +
				chunks
					.map((chunk, index) => `[${index + 1}] ${chunk.filename}\n${chunk.content}`)
					.join("\n\n"),
		);
	}

	if (history.length > 0) {
		sections.push(
			"Conversation history:\n" +
				history.map((message) => `${message.role}: ${message.content ?? ""}`).join("\n"),
		);
	}

	sections.push(`User: ${prompt}`);

	return sections.join("\n\n");
}
