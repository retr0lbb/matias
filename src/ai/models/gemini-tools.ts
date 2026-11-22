import type {
	Content,
	FunctionCall,
	GenerateContentConfig,
	GenerateContentParameters,
	GenerateContentResponse,
	Part,
} from "@google/genai";
import type { MessageTokenUsage } from "../../db/schemas/message.js";
import type { ToolCallRecord, ToolRuntime } from "../../shared/tools/tool-runtime.js";
import type { AIResponse, AIStreamChunk } from "../ai-provider.type.js";
import { toTokenUsage } from "./gemini-response.js";

/** Rounds the model may call tools in; one more round without tools then forces an answer. */
export const MAX_TOOL_ROUNDS = 4;

/** The part of `GoogleGenAI` the loop needs, so tests can fake it. */
export interface GeminiStreamClient {
	models: {
		generateContentStream(
			params: GenerateContentParameters,
		): Promise<AsyncGenerator<GenerateContentResponse>>;
	};
}

export interface ToolLoopRequest {
	model: string;
	/** The user turn (prompt with history and RAG context), as the models send it today. */
	message: string;
	config: GenerateContentConfig;
	thinkingLevel: string;
}

/**
 * Streams an answer while letting Gemini call tools: each round streams text
 * and thoughts as they come; when the model asks for function calls, they run
 * and their results go back as the next round's input. After MAX_TOOL_ROUNDS
 * rounds with calls, a last round runs without tools. Ends with one `done`
 * chunk whose tokens add up every round.
 */
export async function* streamWithTools(
	client: GeminiStreamClient,
	request: ToolLoopRequest,
	tools: ToolRuntime,
	startedAt: Date,
): AsyncGenerator<AIStreamChunk> {
	const contents: Content[] = [{ role: "user", parts: [{ text: request.message }] }];
	const toolCalls: ToolCallRecord[] = [];
	let tokens = emptyTokens();
	let outputText = "";
	let thinkingText = "";
	let responseId: string | undefined;
	let modelVersion: string | undefined;
	let finishReason: string | undefined;

	for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
		request.config.abortSignal?.throwIfAborted();
		const offerTools = round < MAX_TOOL_ROUNDS && tools.declarations.length > 0;

		const stream = await client.models.generateContentStream({
			model: request.model,
			contents,
			config: offerTools
				? { ...request.config, tools: [{ functionDeclarations: tools.declarations }] }
				: request.config,
		});

		// Every part is kept as is: function calls carry thought signatures Gemini wants back.
		const modelParts: Part[] = [];
		const calls: FunctionCall[] = [];
		let usage: GenerateContentResponse["usageMetadata"];

		for await (const chunk of stream) {
			responseId = chunk.responseId ?? responseId;
			modelVersion = chunk.modelVersion ?? modelVersion;
			usage = chunk.usageMetadata ?? usage;

			const candidate = chunk.candidates?.[0];
			finishReason = candidate?.finishReason ?? finishReason;

			for (const part of candidate?.content?.parts ?? []) {
				modelParts.push(part);

				if (part.functionCall) {
					calls.push(part.functionCall);
				} else if (part.text && part.thought) {
					thinkingText += part.text;
					yield { type: "thinking", text: part.text };
				} else if (part.text) {
					outputText += part.text;
					yield { type: "text", text: part.text };
				}
			}
		}

		tokens = addTokens(tokens, toTokenUsage(usage));

		if (calls.length === 0 || !offerTools) break;

		contents.push({ role: "model", parts: modelParts });
		const responses: Part[] = [];

		for (const call of calls) {
			const name = call.name ?? "";
			yield { type: "tool", name, status: "running" };

			const t0 = performance.now();
			const result = await tools.execute(name, call.args ?? {});
			const ok = !("error" in result);
			toolCalls.push({ name, ok, latencyMs: Math.round(performance.now() - t0) });

			yield { type: "tool", name, status: ok ? "done" : "error" };
			responses.push({ functionResponse: { id: call.id, name, response: result } });
		}

		contents.push({ role: "user", parts: responses });
	}

	const response: AIResponse = {
		messageId: responseId ?? "",
		model: modelVersion ?? request.model,
		modelName: request.model,
		thinkingLevel: request.thinkingLevel,
		status: finishReason ?? "UNKNOWN",
		created: startedAt.toISOString(),
		updated: new Date().toISOString(),
		output_text: outputText,
		thinking_output: thinkingText || undefined,
		usage: { total_input_tokens: tokens.prompt, total_tokens: tokens.total },
		tokens,
		toolCalls,
	};

	yield { type: "done", response };
}

/** Runs the loop to the end and returns the final response, for the non-streaming `generate`. */
export async function generateWithTools(
	client: GeminiStreamClient,
	request: ToolLoopRequest,
	tools: ToolRuntime,
	startedAt: Date,
): Promise<AIResponse> {
	for await (const chunk of streamWithTools(client, request, tools, startedAt)) {
		if (chunk.type === "done") return chunk.response;
	}
	throw new Error("Tool loop ended without a response");
}

function emptyTokens(): MessageTokenUsage {
	return { prompt: 0, output: 0, thoughts: 0, cached: 0, total: 0 };
}

function addTokens(a: MessageTokenUsage, b: MessageTokenUsage): MessageTokenUsage {
	return {
		prompt: a.prompt + b.prompt,
		output: a.output + b.output,
		thoughts: a.thoughts + b.thoughts,
		cached: a.cached + b.cached,
		total: a.total + b.total,
	};
}
