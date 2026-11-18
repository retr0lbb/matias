import type { QuotaExceededBody } from "../../usage/quota-exceeded.exception.js";
import type { ThinkingLevelOption } from "../../usage/plan-limits.js";
import type { AIExpense } from "../ai.factory.js";

export type ModelSelection = "AUTO" | "MANUAL";

export type ChatStreamStage = "classifying" | "retrieving" | "generating";

/** Events sent over `POST /ai/chat/stream` as Server-Sent Events (`event: <type>`). */
export type ChatStreamEvent =
	| { type: "start"; data: { conversationId: string; title: string | null } }
	| {
			type: "status";
			data:
				| { stage: "classifying" | "retrieving" }
				| {
						stage: "generating";
						model: AIExpense;
						title: string | null;
						selection: ModelSelection;
						/** Thinking level the turn runs with. */
						thinkingLevel: ThinkingLevelOption;
						/** AUTO only: the tier the judge wanted but had no quota left. */
						downgradedFrom?: AIExpense;
				  };
	  }
	| { type: "thinking"; data: { text: string } }
	| { type: "text"; data: { text: string } }
	| {
			type: "done";
			data: {
				messageId: string;
				finishReason: string;
				usage: { total_tokens: number; total_input_tokens: number };
			};
	  }
	| {
			type: "error";
			// Quota errors carry the same body the HTTP 429 used to return.
			data: QuotaExceededBody | { code: "GENERATION_FAILED"; message: string };
	  };
