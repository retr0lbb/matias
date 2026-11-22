import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	Logger,
	UnauthorizedException,
} from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { desc, eq } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { ClassroomToolsService } from "../classroom/classroom-tools.service.js";
import { conversationsTable } from "../db/schemas/conversation.js";
import {
	type DocumentTurnMetadata,
	type MessageMetadata,
	messagesTable,
} from "../db/schemas/message.js";
import { userTable } from "../db/schemas/user.js";
import { RagSearchResult, RagService } from "../rag/rag.service.js";
import type { ToolRuntime } from "../shared/tools/tool-runtime.js";
import { isThinkingLevelAllowed, type ThinkingLevelOption } from "../usage/plan-limits.js";
import {
	type QuotaExceededBody,
	QuotaExceededException,
} from "../usage/quota-exceeded.exception.js";
import { type ChatAllowance, type MessageExpense, UsageService } from "../usage/usage.service.js";
import { AIExpense, AiExpensesFactory } from "./ai.factory.js";
import type { AIResponse } from "./ai-provider.type.js";
import type { DocumentPromptContext, ToolsPromptContext } from "./constants/prompts.js";
import {
	type ConversationDocument,
	DOCUMENT_RAG_LIMIT,
	type DocumentIntent,
	DocumentTurnService,
	isGenerating,
	requiredTier,
} from "./document-turn.service.js";
import type { ChatOptions } from "./dto/chat-body.dto.js";
import type { ChatStreamEvent, ModelSelection } from "./dto/chat-stream-event.js";
import { type JudgeClassification, JudgeModel } from "./models/judge-model.js";
import { MODEL_IDS } from "./models/model-catalog.js";

const HISTORY_LIMIT = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type History = { role: "USER" | "IA"; content: string | null }[];

export interface ChatStreamContext {
	user: typeof userTable.$inferSelect;
	prompt: string;
	conversation: { id: string; title: string | null };
	/** RAG only runs when the client sent a conversationId. */
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
	upgradedFrom?: AIExpense;
	thinkingLevel: ThinkingLevelOption;
	judge: JudgeClassification;
	/** What the turn does about documents, checked against the conversation. */
	document: DocumentIntent;
}

/** Tools for a turn whose judge picked some: a runtime when offered, and the prompt context. */
interface TurnTools {
	runtime?: ToolRuntime;
	prompt: ToolsPromptContext;
}

@Injectable()
export class AiService {
	private readonly logger = new Logger(AiService.name);

	constructor(
		private readonly aiFactory: AiExpensesFactory,
		@InjectDrizzle() private readonly db: NodePgDatabase,
		private readonly ragService: RagService,
		private readonly usageService: UsageService,
		private readonly judgeModel: JudgeModel,
		private readonly classroomTools: ClassroomToolsService,
		private readonly documentTurn: DocumentTurnService,
	) {}

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

		let conversation: { id: string; userId: string; title: string | null };

		if (conversationId) {
			if (!UUID_PATTERN.test(conversationId)) {
				throw new BadRequestException("conversationId must be a UUID");
			}

			const [foundConversation] = await this.db
				.select()
				.from(conversationsTable)
				.where(eq(conversationsTable.id, conversationId));

			if (foundConversation && foundConversation.userId !== loggedUser) {
				throw new ForbiddenException("Not your chat pal");
			}

			if (foundConversation) {
				conversation = foundConversation;
			} else {
				// Clients can pre-generate the conversation id so documents uploaded
				// with that id are found when the chat starts.
				const [newConversation] = await this.db
					.insert(conversationsTable)
					.values({
						id: conversationId,
						userId: loggedUser,
					})
					.returning();

				conversation = newConversation;
			}
		} else {
			const [newConversation] = await this.db
				.insert(conversationsTable)
				.values({
					userId: loggedUser,
				})
				.returning();

			conversation = newConversation;
		}

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
	 *
	 * A document turn builds (or changes) the document before the chat answer,
	 * so the answer can describe it and Classroom tools can attach it.
	 */
	async *streamAnswer(
		ctx: ChatStreamContext,
		signal: AbortSignal,
	): AsyncGenerator<ChatStreamEvent> {
		let partial = "";
		let partialThinking = "";
		let final: AIResponse | undefined;
		let turn: Turn | undefined;
		let documentMetadata: DocumentTurnMetadata | undefined;
		let status: "COMPLETED" | "FAILED" | "ERROR" = "FAILED";

		yield {
			type: "start",
			data: { conversationId: ctx.conversation.id, title: ctx.conversation.title },
		};

		try {
			yield { type: "status", data: { stage: "classifying" } };

			const history = (
				await this.db
					.select({
						role: messagesTable.role,
						content: messagesTable.content,
					})
					.from(messagesTable)
					.where(eq(messagesTable.conversationId, ctx.conversation.id))
					.orderBy(desc(messagesTable.createdAt))
					.limit(HISTORY_LIMIT)
			).reverse();

			const documents = await this.documentTurn.listDocuments(ctx.user.id, ctx.conversation.id);
			turn = await this.planTurn(ctx, history, documents);
			const judgeResponse = turn.judge;

			if (judgeResponse.title && !ctx.conversation.title) {
				await this.db
					.update(conversationsTable)
					.set({ title: judgeResponse.title })
					.where(eq(conversationsTable.id, ctx.conversation.id));

				ctx.conversation.title = judgeResponse.title;
			}

			const generatesDocument = isGenerating(turn.document);
			let chunks: RagSearchResult[] = [];
			if (judgeResponse.retrieve && ctx.ragEnabled) {
				yield { type: "status", data: { stage: "retrieving" } };
				chunks = await this.retrieveContext(
					ctx.prompt,
					ctx.user.id,
					ctx.conversation.id,
					generatesDocument ? DOCUMENT_RAG_LIMIT : undefined,
				);
			}

			await this.db.insert(messagesTable).values({
				conversationId: ctx.conversation.id,
				role: "USER",
				content: ctx.prompt,
			});

			let documentPrompt: DocumentPromptContext | undefined;

			if (turn.document.kind === "ASK_HEADER") {
				documentPrompt = { status: "ASK_HEADER", type: turn.document.type, missing: turn.document.missing };
				documentMetadata = {
					action: "ASK_HEADER",
					type: turn.document.type,
					missing: turn.document.missing,
				};
			} else if (isGenerating(turn.document)) {
				const intent = turn.document;
				yield {
					type: "status",
					data: { stage: "documenting", action: intent.kind, documentType: intent.type },
				};

				// No abort signal here: if the client leaves, the document still
				// finishes and is saved, so a spent credit is never wasted.
				const outcome = await this.documentTurn.run(intent, {
					user: ctx.user,
					conversationId: ctx.conversation.id,
					prompt: ctx.prompt,
					history,
					chunks,
					model: MODEL_IDS[turn.model],
					thinkingLevel: turn.thinkingLevel,
				});
				documentPrompt = outcome.prompt;
				documentMetadata = outcome.metadata;

				if (outcome.ok) {
					const { view } = outcome.result;
					yield {
						type: "document",
						data: {
							id: view.id,
							documentType: intent.type,
							action: intent.kind,
							title: view.document.content.title,
							version: view.version,
						},
					};
				} else {
					yield {
						type: "status",
						data: { stage: "document_failed", action: intent.kind, documentType: intent.type },
					};
				}
			}

			const input = buildRagPrompt(ctx.prompt, chunks, history);
			const provider = this.aiFactory.create(turn.model);
			// After the document, so a document made this turn can be attached to a Classroom assignment.
			const tools = await this.resolveTools(
				ctx.user.id,
				ctx.conversation.id,
				turn,
				ctx.allowance,
			);

			yield {
				type: "status",
				data: {
					stage: "generating",
					model: turn.model,
					title: ctx.conversation.title,
					selection: turn.selection,
					thinkingLevel: turn.thinkingLevel,
					downgradedFrom: turn.downgradedFrom,
					upgradedFrom: turn.upgradedFrom,
				},
			};
			for await (const chunk of provider.generateStream({
				message: input,
				signal,
				thinkingLevel: turn.thinkingLevel,
				tools: tools?.runtime,
				prompt: {
					needRetrieval: judgeResponse.retrieve,
					needTools: Boolean(tools),
					tools: tools?.prompt,
					tier: turn.model,
					document: documentPrompt,
				},
			})) {
				if (chunk.type === "text") {
					partial += chunk.text;
					yield { type: "text", data: { text: chunk.text } };
				} else if (chunk.type === "thinking") {
					partialThinking += chunk.text;
					yield { type: "thinking", data: { text: chunk.text } };
				} else if (chunk.type === "tool") {
					yield { type: "tool", data: { name: chunk.name, status: chunk.status } };
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
				await this.saveStreamedMessage(ctx, turn, {
					content: final?.output_text ?? partial,
					final,
					status,
					partialThinking,
					document: documentMetadata,
				});
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
	 * downgrades when that tier has no quota left. A document turn raises the
	 * tier to what the document needs (never CHEAP), for AUTO and MANUAL picks
	 * alike, and may move up a tier when that one is full.
	 */
	private async planTurn(
		ctx: ChatStreamContext,
		history: History,
		documents: ConversationDocument[],
	): Promise<Turn> {
		const { options, allowance } = ctx;
		const judgeInput = { prompt: ctx.prompt, history, documents };
		let judge: JudgeClassification;
		let preferred: MessageExpense;

		if (options.model === "AUTO") {
			const routed = await this.judgeModel.classify({ ...judgeInput, routeModel: true });
			judge = routed;
			preferred = routed.model;
		} else {
			judge = await this.judgeModel.classify({ ...judgeInput, routeModel: false });
			preferred = options.model;
		}

		const document = await this.documentTurn.resolveIntent(
			judge.document,
			documents,
			ctx.conversation.id,
		);
		const minimum = requiredTier(document);
		const selection: ModelSelection = options.model === "AUTO" ? "AUTO" : "MANUAL";
		// A MANUAL CHEAP pick skipped the thinking-level check; a raised tier must still respect the plan.
		const maxThinking = allowance.plan.limits.maxThinkingLevel;
		const thinkingLevel = isThinkingLevelAllowed(options.thinkingLevel, maxThinking)
			? options.thinkingLevel
			: maxThinking;

		// MANUAL with no document need: the pick and its quota were checked in loadAllowance.
		if (selection === "MANUAL" && !minimum) {
			return { model: AIExpense[preferred], selection, judge, document, thinkingLevel };
		}

		const choice = this.usageService.pickAvailableModel(allowance, preferred, minimum);

		return {
			model: AIExpense[choice.model],
			selection,
			downgradedFrom: choice.downgradedFrom && AIExpense[choice.downgradedFrom],
			upgradedFrom: choice.upgradedFrom && AIExpense[choice.upgradedFrom],
			judge,
			document,
			thinkingLevel,
		};
	}

	private async saveStreamedMessage(
		ctx: ChatStreamContext,
		turn: Turn,
		message: {
			content: string;
			final: AIResponse | undefined;
			status: "COMPLETED" | "FAILED" | "ERROR";
			partialThinking: string;
			document?: DocumentTurnMetadata;
		},
	): Promise<void> {
		const { content, final, status, partialThinking, document } = message;

		// A document made this turn is recorded even when no answer text came back.
		if (content.length === 0 && !document) {
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
				metadata: { ...this.buildMetadata(turn, final, partialThinking), document },
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
			upgradedFrom: turn.upgradedFrom,
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
			...(final.toolCalls?.length && { tools: final.toolCalls }),
		};
	}

	/**
	 * Undefined when the judge picked no tool. Otherwise the tools are offered
	 * only to a paid plan with Classroom connected (on any model tier); in any
	 * other case the prompt says why, so the model can tell the user.
	 */
	private async resolveTools(
		userId: string,
		conversationId: string,
		turn: Turn,
		allowance: ChatAllowance,
	): Promise<TurnTools | undefined> {
		const names = turn.judge.tools;
		if (names.length === 0) return undefined;

		const unavailable = (reason: NonNullable<ToolsPromptContext["unavailable"]>): TurnTools => ({
			prompt: { unavailable: reason, assessments: [] },
		});

		if (!allowance.plan.limits.classroomTools) return unavailable("PLAN");

		try {
			if (!(await this.classroomTools.isConnected(userId))) return unavailable("NOT_CONNECTED");

			const assessments = await this.classroomTools.listConversationAssessments(
				userId,
				conversationId,
			);
			return { runtime: this.classroomTools.forUser(userId, names), prompt: { assessments } };
		} catch (error) {
			// The chat still answers; the model explains Classroom could not be reached.
			this.logger.error(`[TOOLS] could not prepare Classroom tools for user=${userId}`, error);
			return unavailable("NOT_CONNECTED");
		}
	}

	private async retrieveContext(
		prompt: string,
		userId: string,
		conversationId: string,
		limit?: number,
	) {
		try {
			const ready = await this.ragService.hasReadyDocuments(userId, conversationId);
			this.logger.log(`[RAG] conversation=${conversationId} ready=${ready}`);
			if (!ready) return [];

			const results = await this.ragService.search(prompt, userId, { conversationId, limit });
			this.logger.log(`[RAG] results=${results.length}`);
			return results;
		} catch (error) {
			this.logger.error("[RAG] search failed", error);
			return [];
		}
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
