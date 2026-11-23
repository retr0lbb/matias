import { type GenerateContentResponse, ThinkingLevel } from "@google/genai";
import type { MessageTokenUsage } from "../../db/schemas/message.js";
import type { ThinkingLevelOption } from "../../usage/plan-limits.js";

const GEMINI_THINKING_LEVEL: Record<ThinkingLevelOption, ThinkingLevel> = {
	DEFAULT: ThinkingLevel.LOW,
	HIGH: ThinkingLevel.MEDIUM,
	ULTRA_HIGH: ThinkingLevel.HIGH,
};

/** User-facing level → Gemini level (DEFAULT=LOW, HIGH=MEDIUM, ULTRA_HIGH=HIGH). */
export function toGeminiThinkingLevel(level: ThinkingLevelOption): ThinkingLevel {
	return GEMINI_THINKING_LEVEL[level];
}

/** Maps Gemini `usageMetadata` to the token breakdown stored on messages. */
export function toTokenUsage(usage: GenerateContentResponse["usageMetadata"]): MessageTokenUsage {
	return {
		prompt: usage?.promptTokenCount ?? 0,
		output: usage?.candidatesTokenCount ?? 0,
		thoughts: usage?.thoughtsTokenCount ?? 0,
		cached: usage?.cachedContentTokenCount ?? 0,
		total: usage?.totalTokenCount ?? 0,
	};
}
