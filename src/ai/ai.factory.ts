import { Injectable } from "@nestjs/common";
import type { AiProvider } from "./ai-provider.type.js";
import { GeminiClient } from "./gemini.client.js";
import { GeminiChatModel } from "./models/gemini-chat.model.js";

export enum AIExpense {
	CHEAP = "CHEAP",
	EXPENSIVE = "EXPENSIVE",
	NORMAL = "NORMAL",
}

@Injectable()
export class AiExpensesFactory {
	constructor(private readonly gemini: GeminiClient) {}

	create(expense: AIExpense): AiProvider {
		return new GeminiChatModel(this.gemini.genai, expense);
	}
}
