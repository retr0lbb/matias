import { type GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { AIStreamChunk, AiProvider, GenerateInput } from "../ai-provider.type.js";
import { buildPrompt } from "../constants/prompts.js";
import { toGeminiThinkingLevel } from "./gemini-response.js";
import { mapGeminiStream } from "./gemini-stream.js";
import { streamWithTools } from "./gemini-tools.js";
import { CHAT_MAX_OUTPUT_TOKENS, MODEL_IDS, type ModelTier } from "./model-catalog.js";

/**
 * Streams a chat answer on one tier. CHEAP always thinks at MINIMAL and hides
 * its thoughts; NORMAL and EXPENSIVE use the turn's thinking level and stream
 * their thoughts. Tools (Classroom) work on every tier.
 */
export class GeminiChatModel implements AiProvider {
	constructor(
		private readonly client: GoogleGenAI,
		private readonly tier: ModelTier,
	) {}

	async *generateStream(input: GenerateInput & { signal?: AbortSignal }): AsyncGenerator<AIStreamChunk> {
		const startedAt = new Date();
		const model = MODEL_IDS[this.tier];
		const cheap = this.tier === "CHEAP";
		const thinkingLevel = cheap ? ThinkingLevel.MINIMAL : toGeminiThinkingLevel(input.thinkingLevel);
		const config = {
			maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS[this.tier],
			thinkingConfig: { thinkingLevel, includeThoughts: !cheap },
			abortSignal: input.signal,
			systemInstruction: buildPrompt(input.prompt),
		};

		if (input.tools) {
			yield* streamWithTools(
				this.client,
				{ model, message: input.message, thinkingLevel, config },
				input.tools,
				startedAt,
			);
			return;
		}

		const stream = await this.client.models.generateContentStream({
			model,
			contents: input.message,
			config,
		});

		yield* mapGeminiStream(stream, { modelName: model, thinkingLevel }, startedAt);
	}
}
