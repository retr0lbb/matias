import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { AIResponse, AIStreamChunk, AiProvider } from "../ai-provider.type.js";
import { buildPrompt, PromptProps } from "../constants/prompts.js";
import { mapGeminiStream } from "./gemini-stream.js";

// Troque aqui para rodar a matriz de testes
const MODEL = "gemini-3.8-flash";
const THINKING_LEVEL = ThinkingLevel.LOW;

export class ExpensiveModel implements AiProvider {
	private readonly client: GoogleGenAI;

	constructor(apiKey: string) {
		this.client = new GoogleGenAI({
			apiKey: apiKey,
			httpOptions: { timeout: 90_000 },
		});
	}

	async generate(input: { message: string; prompt: PromptProps }): Promise<AIResponse> {
		const startedAt = new Date();
		const t0 = performance.now();

		try {
			const response = await this.client.models.generateContent({
				model: MODEL,
				contents: input.message,
				config: {
					maxOutputTokens: 2048 * 2,
					thinkingConfig: { thinkingLevel: THINKING_LEVEL },
					systemInstruction: buildPrompt(input.prompt),
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
		} catch (error) {
			console.log(error);
			throw error;
		} finally {
			console.log("[GENERATE] elapsed", Math.round(performance.now() - t0), "ms");
		}
	}

	async *generateStream(input: {
		message: string;
		signal?: AbortSignal;
		prompt: PromptProps;
	}): AsyncGenerator<AIStreamChunk> {
		const startedAt = new Date();

		const stream = await this.client.models.generateContentStream({
			model: MODEL,
			contents: input.message,
			config: {
				maxOutputTokens: 2048 * 2,
				thinkingConfig: { thinkingLevel: THINKING_LEVEL, includeThoughts: true },
				abortSignal: input.signal,
				systemInstruction: buildPrompt(input.prompt),
			},
		});

		yield* mapGeminiStream(stream, MODEL, startedAt);
	}
}
