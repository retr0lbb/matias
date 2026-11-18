import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { AIResponse, AIStreamChunk, AiProvider } from "../ai-provider.type.js";
import { mapGeminiStream } from "./gemini-stream.js";

// Troque aqui para rodar a matriz de testes
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

	async generate(input: { message: string }): Promise<AIResponse> {
		const startedAt = new Date();

		const response = await this.client.models.generateContent({
			model: MODEL,
			contents: input.message,
			config: {
				maxOutputTokens: 2048,
				thinkingConfig: { thinkingLevel: THINKING_LEVEL },
			},
		});

		const usage = response.usageMetadata;

		return {
			messageId: response.responseId ?? "",
			model: response.modelVersion ?? MODEL,
			status: response.candidates?.[0]?.finishReason ?? "UNKNOWN",
			created: startedAt.toISOString(),
			updated: new Date().toISOString(),
			output_text: response.text ?? "",
			usage: {
				total_input_tokens: usage?.promptTokenCount ?? 0,
				total_tokens: usage?.totalTokenCount ?? 0,
			},
		};
	}

	async *generateStream(input: {
		message: string;
		signal?: AbortSignal;
	}): AsyncGenerator<AIStreamChunk> {
		const startedAt = new Date();

		const stream = await this.client.models.generateContentStream({
			model: MODEL,
			contents: input.message,
			config: {
				maxOutputTokens: 2048,
				thinkingConfig: { thinkingLevel: THINKING_LEVEL, includeThoughts: false },
				abortSignal: input.signal,
			},
		});

		yield* mapGeminiStream(stream, MODEL, startedAt);
	}
}
