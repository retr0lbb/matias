import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { Injectable } from "@nestjs/common";
import { JudgeReponse, judgeReponseSchema } from "../dto/judge-response.dto.js";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class JudgeModel {
	private readonly client: GoogleGenAI;

	constructor(private readonly configService: ConfigService) {
		const key = this.configService.getOrThrow<string>("GEMINI_API_KEY");
		console.log("gemini key:", key.slice(0, 6), "...", key.slice(-4));
		this.client = new GoogleGenAI({
			apiKey: key,
		});
	}

	async classify(
		prompt: string,
		history: { role: "USER" | "IA"; content: string | null }[],
	): Promise<JudgeReponse> {
		const totalStart = performance.now();
		const timings: Record<string, number> = {};

		let interaction: Awaited<ReturnType<typeof this.client.models.generateContent>> | undefined;

		try {
			// 1. Preparação do prompt
			let start = performance.now();

			const contents = `
      You are the routing judge for Matita AI.
      Analyze the conversation history and the latest user message.
	  Generate the title in Brazilian Portuguese, with proper accents

      You must determine:
      - The appropriate model tier.
      - Whether document retrieval is necessary.
      - Which registered tools are required.
      - Generate a small title IF history is empty.

      {CONVERSATION_HISTORY}
      ${JSON.stringify(history)}

      {USER_LATEST_MESSAGE}
      ${prompt}
    `;

			timings.promptBuild = performance.now() - start;

			// 2. Requisição Gemini
			start = performance.now();

			interaction = await this.client.models.generateContent({
				model: "gemini-3.1-flash-lite",
				contents,
				config: {
					thinkingConfig: {
						thinkingLevel: ThinkingLevel.MINIMAL,
						includeThoughts: true,
					},
					responseMimeType: "application/json",
					responseJsonSchema: {
						type: "object",
						properties: {
							model: {
								type: "string",
								enum: ["CHEAP", "NORMAL", "EXPENSIVE"],
							},
							retrieve: {
								type: "boolean",
							},
							tools: {
								type: "array",
								items: {
									type: "string",
									enum: [
										"classroom.list_classrooms",
										"classroom.list_students",
										"classroom.get_assignments",
									],
								},
							},
							title: {
								type: "string",
							},
						},
						required: ["model", "retrieve", "tools"],
					},
				},
			});

			timings.geminiRequest = performance.now() - start;

			// 3. Parsing JSON
			start = performance.now();

			if (!interaction.text) {
				throw new Error("Gemini returned an empty response");
			}

			const parsed = JSON.parse(interaction.text);

			timings.jsonParsing = performance.now() - start;

			// 4. Validação Zod
			start = performance.now();

			const result = judgeReponseSchema.parse(parsed);

			timings.zodValidation = performance.now() - start;

			return result;
		} finally {
			timings.total = performance.now() - totalStart;

			console.log("[JUDGE PERFORMANCE]", {
				timings,
				usage: interaction?.usageMetadata,
				modelVersion: interaction?.modelVersion,
			});
		}
	}
}
