import { type GoogleGenAI, ThinkingLevel } from "@google/genai";
import { Injectable, Logger } from "@nestjs/common";
import type { JudgeMetadata } from "../../db/schemas/message.js";
import { DOCUMENT_TYPES } from "../../documents/types/document-type.js";
import { AI_HEADER_FIELDS } from "../../documents/schemas/header.schema.js";
import { buildJudgePrompt, type JudgePromptProps } from "../constants/prompts.js";
import {
	DOCUMENT_ACTIONS,
	DOCUMENT_COMPLEXITIES,
	JUDGE_MODELS,
	type JudgeReponse,
	judgeReponseSchema,
	type RoutedJudgeReponse,
	routedJudgeReponseSchema,
	TOOL_NAMES,
} from "../dto/judge-response.dto.js";
import { GeminiClient } from "../gemini.client.js";
import { toTokenUsage } from "./gemini-response.js";
import { JUDGE_MODEL_ID } from "./model-catalog.js";

type JudgeInput = Omit<JudgePromptProps, "routeModel">;

/** Judge decision plus the judge call's own usage, persisted in message metadata. */
export type JudgeClassification = JudgeReponse & { usage: JudgeMetadata };
export type RoutedJudgeClassification = RoutedJudgeReponse & { usage: JudgeMetadata };

@Injectable()
export class JudgeModel {
	private readonly logger = new Logger(JudgeModel.name);
	private readonly client: GoogleGenAI;

	constructor(gemini: GeminiClient) {
		this.client = gemini.genai;
	}

	/**
	 * Decides retrieval, tools, the document intent and the conversation title.
	 * With `routeModel` (AUTO mode) it also picks the model tier; otherwise the
	 * user already chose it.
	 */
	classify(input: JudgeInput & { routeModel: true }): Promise<RoutedJudgeClassification>;
	classify(input: JudgeInput & { routeModel: false }): Promise<JudgeClassification>;
	async classify(
		input: JudgePromptProps,
	): Promise<JudgeClassification | RoutedJudgeClassification> {
		const startedAt = performance.now();

		const response = await this.client.models.generateContent({
			model: JUDGE_MODEL_ID,
			contents: buildJudgePrompt(input),
			config: {
				thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
				responseMimeType: "application/json",
				responseJsonSchema: responseSchema(input.routeModel),
			},
		});

		const latencyMs = Math.round(performance.now() - startedAt);

		if (!response.text) {
			throw new Error("Judge returned an empty response");
		}

		const schema = input.routeModel ? routedJudgeReponseSchema : judgeReponseSchema;
		const result = schema.parse(JSON.parse(response.text));

		const usage: JudgeMetadata = {
			modelId: response.modelVersion ?? JUDGE_MODEL_ID,
			latencyMs,
			tokens: toTokenUsage(response.usageMetadata),
		};

		this.logger.debug(
			`[JUDGE] ${latencyMs}ms tokens=${usage.tokens.total} route=${input.routeModel} result=${JSON.stringify(result)}`,
		);

		return { ...result, usage };
	}
}

function responseSchema(routeModel: boolean) {
	const properties: Record<string, unknown> = {
		retrieve: { type: "boolean" },
		tools: { type: "array", items: { type: "string", enum: [...TOOL_NAMES] } },
		document: {
			type: "object",
			properties: {
				action: { type: "string", enum: [...DOCUMENT_ACTIONS] },
				type: { type: "string", enum: [...DOCUMENT_TYPES] },
				targetId: { type: "string" },
				complexity: { type: "string", enum: [...DOCUMENT_COMPLEXITIES] },
				missingHeader: { type: "array", items: { type: "string", enum: [...AI_HEADER_FIELDS] } },
			},
			required: ["action"],
		},
		title: { type: "string" },
	};
	const required = ["retrieve", "tools", "document"];

	if (routeModel) {
		properties.model = { type: "string", enum: [...JUDGE_MODELS] };
		required.unshift("model");
	}

	return { type: "object", properties, required };
}
