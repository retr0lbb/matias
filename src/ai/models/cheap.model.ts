import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { AIResponse, AIStreamChunk, AiProvider, GenerateInput } from "../ai-provider.type.js";
import { buildPrompt } from "../constants/prompts.js";
import { extractThoughts, toTokenUsage } from "./gemini-response.js";
import { mapGeminiStream } from "./gemini-stream.js";

const MODEL = "gemini-3.5-flash";
const THINKING_LEVEL = ThinkingLevel.MINIMAL;

export class CheapModel implements AiProvider {
	private readonly client: GoogleGenAI;

	constructor(apiKey: string) {
		this.client = new GoogleGenAI({
			apiKey: apiKey,
			httpOptions: { timeout: 90_000 },
		});
	}

	async generate(input: GenerateInput): Promise<AIResponse> {
		const startedAt = new Date();

		const response = await this.client.models.generateContent({
			model: MODEL,
			contents: input.message,
			config: {
				maxOutputTokens: 2048,
				thinkingConfig: { thinkingLevel: THINKING_LEVEL, includeThoughts: true },
				systemInstruction: buildPrompt(input.prompt),
			},
		});

		const usage = response.usageMetadata;

		return {
			messageId: response.responseId ?? "",
			model: response.modelVersion ?? MODEL,
			modelName: MODEL,
			thinkingLevel: THINKING_LEVEL,
			status: response.candidates?.[0]?.finishReason ?? "UNKNOWN",
			created: startedAt.toISOString(),
			updated: new Date().toISOString(),
			output_text: response.text ?? "",
			thinking_output: extractThoughts(response),
			usage: {
				total_input_tokens: usage?.promptTokenCount ?? 0,
				total_tokens: usage?.totalTokenCount ?? 0,
			},
			tokens: toTokenUsage(usage),
		};
	}

	async *generateStream(input: GenerateInput & { signal?: AbortSignal }): AsyncGenerator<AIStreamChunk> {
		const startedAt = new Date();

		const stream = await this.client.models.generateContentStream({
			model: MODEL,
			contents: input.message,
			config: {
				maxOutputTokens: 2048,
				thinkingConfig: { thinkingLevel: THINKING_LEVEL, includeThoughts: false },
				systemInstruction: buildPrompt(input.prompt),

				abortSignal: input.signal,
			},
		});

		yield* mapGeminiStream(stream, { modelName: MODEL, thinkingLevel: THINKING_LEVEL }, startedAt);
	}
}
