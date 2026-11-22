import type { MessageTokenUsage } from "../db/schemas/message.js";
import type { ToolCallRecord, ToolRuntime } from "../shared/tools/tool-runtime.js";
import type { ThinkingLevelOption } from "../usage/plan-limits.js";
import { PromptProps } from "./constants/prompts.js";

export type GenerateInput = {
	message: string;
	prompt: PromptProps;
	/** Already clamped to the plan's max. CHEAP ignores it (always MINIMAL). */
	thinkingLevel: ThinkingLevelOption;
	/** Tools the model may call this turn. */
	tools?: ToolRuntime;
};

export interface AiProvider {
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
	/** Tools called while answering, in order (no arguments or results). */
	toolCalls?: ToolCallRecord[];
};

export type AIStreamChunk =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool"; name: string; status: "running" | "done" | "error" }
	| { type: "done"; response: AIResponse };
