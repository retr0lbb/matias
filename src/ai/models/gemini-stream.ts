import type { GenerateContentResponse } from "@google/genai";
import type { AIStreamChunk } from "../ai-provider.type.js";

/**
 * Turns a Gemini `generateContentStream` result into provider-agnostic chunks.
 * Thought parts are only present when the request set `includeThoughts`.
 * Ends with a `done` chunk carrying the same AIResponse shape `generate()` returns.
 */
export async function* mapGeminiStream(
	stream: AsyncGenerator<GenerateContentResponse>,
	fallbackModel: string,
	startedAt: Date,
): AsyncGenerator<AIStreamChunk> {
	let outputText = "";
	let thinkingText = "";
	let responseId: string | undefined;
	let modelVersion: string | undefined;
	let finishReason: string | undefined;
	let usage: GenerateContentResponse["usageMetadata"];

	for await (const chunk of stream) {
		responseId = chunk.responseId ?? responseId;
		modelVersion = chunk.modelVersion ?? modelVersion;
		usage = chunk.usageMetadata ?? usage;

		const candidate = chunk.candidates?.[0];
		finishReason = candidate?.finishReason ?? finishReason;

		for (const part of candidate?.content?.parts ?? []) {
			if (!part.text) {
				continue;
			}

			if (part.thought) {
				thinkingText += part.text;
				yield { type: "thinking", text: part.text };
			} else {
				outputText += part.text;
				yield { type: "text", text: part.text };
			}
		}
	}

	yield {
		type: "done",
		response: {
			messageId: responseId ?? "",
			model: modelVersion ?? fallbackModel,
			status: finishReason ?? "UNKNOWN",
			created: startedAt.toISOString(),
			updated: new Date().toISOString(),
			output_text: outputText,
			thinking_output: thinkingText || undefined,
			usage: {
				total_input_tokens: usage?.promptTokenCount ?? 0,
				total_tokens: usage?.totalTokenCount ?? 0,
			},
		},
	};
}
