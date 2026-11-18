import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { JudgeMetadata } from "../../db/schemas/message.js";
import { buildJudgePrompt, type JudgePromptProps } from "../constants/prompts.js";
import {
	JUDGE_MODELS,
	type JudgeReponse,
	judgeReponseSchema,
	type RoutedJudgeReponse,
	routedJudgeReponseSchema,
	TOOL_NAMES,
} from "../dto/judge-response.dto.js";
import { toTokenUsage } from "./gemini-response.js";

const JUDGE_MODEL = "gemini-3.1-flash-lite";

type History = JudgePromptProps["history"];

/** Judge decision plus the judge call's own usage, persisted in message metadata. */
export type JudgeClassification = JudgeReponse & { usage: JudgeMetadata };
export type RoutedJudgeClassification = RoutedJudgeReponse & { usage: JudgeMetadata };

@Injectable()
export class JudgeModel {
	private readonly logger = new Logger(JudgeModel.name);
	private readonly client: GoogleGenAI;

	constructor(private readonly configService: ConfigService) {
		this.client = new GoogleGenAI({
			apiKey: this.configService.getOrThrow<string>("GEMINI_API_KEY"),
		});
	}

	/**
	 * Decides retrieval, tools and the conversation title. With `routeModel`
	 * (AUTO mode) it also picks the model tier; otherwise the user already chose it.
	 */
	classify(input: { prompt: string; history: History; routeModel: true }): Promise<RoutedJudgeClassification>;
	classify(input: { prompt: string; history: History; routeModel: false }): Promise<JudgeClassification>;
	async classify(
		input: JudgePromptProps,
	): Promise<JudgeClassification | RoutedJudgeClassification> {
		const startedAt = performance.now();

		const response = await this.client.models.generateContent({
			model: JUDGE_MODEL,
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
			modelId: response.modelVersion ?? JUDGE_MODEL,
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
		title: { type: "string" },
	};
	const required = ["retrieve", "tools"];

	if (routeModel) {
		properties.model = { type: "string", enum: [...JUDGE_MODELS] };
		required.unshift("model");
	}

	return { type: "object", properties, required };
}
