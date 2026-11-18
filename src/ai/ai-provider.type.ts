import type { MessageTokenUsage } from "../db/schemas/message.js";
import type { ThinkingLevelOption } from "../usage/plan-limits.js";
import { PromptProps } from "./constants/prompts.js";

export type GenerateInput = {
	message: string;
	prompt: PromptProps;
	/** Already clamped to the plan's max. CHEAP ignores it (always MINIMAL). */
	thinkingLevel: ThinkingLevelOption;
};

export interface AiProvider {
	generate(input: GenerateInput): Promise<AIResponse>;
	generateStream(input: GenerateInput & { signal?: AbortSignal }): AsyncGenerator<AIStreamChunk>;
}

export type AIResponse = {
	messageId: string;
	status: string;
	/** Public shape sent to clients in the SSE `done` event; keep stable. */
	usage: {
		total_tokens: number;
		total_input_tokens: number;
	};
	/** Full breakdown, persisted in message metadata. */
	tokens: MessageTokenUsage;
	created: string;
	updated: string;
	/** Model version Gemini reports it used. */
	model: string;
	/** Model the app requested. */
	modelName: string;
	thinkingLevel: string;
	output_text: string;
	thinking_output?: string;
};

export type AIStreamChunk =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "done"; response: AIResponse };
