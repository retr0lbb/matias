import { GoogleGenAI } from "@google/genai";
import type { AIResponse, AIStreamChunk, AiProvider, GenerateInput } from "../ai-provider.type.js";
import { buildPrompt } from "../constants/prompts.js";
import { extractThoughts, toGeminiThinkingLevel, toTokenUsage } from "./gemini-response.js";
import { mapGeminiStream } from "./gemini-stream.js";
import { generateWithTools, streamWithTools } from "./gemini-tools.js";

// Troque aqui para rodar a matriz de testes
const MODEL = "gemini-3.8-flash";

export class ExpensiveModel implements AiProvider {
	private readonly client: GoogleGenAI;

	constructor(apiKey: string) {
		this.client = new GoogleGenAI({
			apiKey: apiKey,
			httpOptions: { timeout: 90_000 },
		});
	}

	async generate(input: GenerateInput): Promise<AIResponse> {
		const startedAt = new Date();
		const t0 = performance.now();
		const thinkingLevel = toGeminiThinkingLevel(input.thinkingLevel);

		if (input.tools) {
			return generateWithTools(
				this.client,
				{
					model: MODEL,
					message: input.message,
					thinkingLevel,
					config: {
						maxOutputTokens: 2048 * 2,
						thinkingConfig: { thinkingLevel, includeThoughts: true },
						systemInstruction: buildPrompt(input.prompt),
					},
				},
				input.tools,
				startedAt,
			);
		}

		try {
			const response = await this.client.models.generateContent({
				model: MODEL,
				contents: input.message,
				config: {
					maxOutputTokens: 2048 * 2,
					thinkingConfig: { thinkingLevel, includeThoughts: true },
					systemInstruction: buildPrompt(input.prompt),
				},
			});

			const usage = response.usageMetadata;
			return {
				messageId: response.responseId ?? "",
				model: response.modelVersion ?? MODEL,
				modelName: MODEL,
				thinkingLevel,
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
		} catch (error) {
			console.log(error);
			throw error;
		} finally {
			console.log("[GENERATE] elapsed", Math.round(performance.now() - t0), "ms");
		}
	}

	async *generateStream(input: GenerateInput & { signal?: AbortSignal }): AsyncGenerator<AIStreamChunk> {
		const startedAt = new Date();
		const thinkingLevel = toGeminiThinkingLevel(input.thinkingLevel);

		if (input.tools) {
			yield* streamWithTools(
				this.client,
				{
					model: MODEL,
					message: input.message,
					thinkingLevel,
					config: {
						maxOutputTokens: 2048 * 2,
						thinkingConfig: { thinkingLevel, includeThoughts: true },
						abortSignal: input.signal,
						systemInstruction: buildPrompt(input.prompt),
					},
				},
				input.tools,
				startedAt,
			);
			return;
		}

		const stream = await this.client.models.generateContentStream({
			model: MODEL,
			contents: input.message,
			config: {
				maxOutputTokens: 2048 * 2,
				thinkingConfig: { thinkingLevel, includeThoughts: true },
				abortSignal: input.signal,
				systemInstruction: buildPrompt(input.prompt),
			},
		});

		yield* mapGeminiStream(stream, { modelName: MODEL, thinkingLevel }, startedAt);
	}
}
