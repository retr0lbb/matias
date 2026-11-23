import type { DocumentType } from "../../documents/types/document-type.js";
import type { QuotaExceededBody } from "../../usage/quota-exceeded.exception.js";
import type { ThinkingLevelOption } from "../../usage/plan-limits.js";
import type { AIExpense } from "../ai.factory.js";
import type { GeneratedDocumentAction } from "../constants/prompts.js";

export type ModelSelection = "AUTO" | "MANUAL";

/** Events sent over `POST /ai/chat/stream` as Server-Sent Events (`event: <type>`). */
export type ChatStreamEvent =
	| { type: "start"; data: { conversationId: string; title: string | null } }
	| {
			type: "status";
			data:
				| { stage: "classifying" | "retrieving" }
				/** The document is being built (it can take a while; no text streams meanwhile). */
				| { stage: "documenting"; action: GeneratedDocumentAction; documentType: DocumentType }
				/** The document could not be built; no credit was spent and the answer explains why. */
				| { stage: "document_failed"; action: GeneratedDocumentAction; documentType: DocumentType }
				| {
						stage: "generating";
						model: AIExpense;
						title: string | null;
						selection: ModelSelection;
						/** Thinking level the turn runs with. */
						thinkingLevel: ThinkingLevelOption;
						/** AUTO only: the tier the judge wanted but had no quota left. */
						downgradedFrom?: AIExpense;
						/** Document turns: the tier picked (by the judge or the user) was below what the document needs. */
						upgradedFrom?: AIExpense;
				  };
	  }
	/** A document was created or changed this turn; fetch it with `GET /documents/:id`. */
	| {
			type: "document";
			data: {
				id: string;
				documentType: DocumentType;
				action: GeneratedDocumentAction;
				title: string;
				version: number;
			};
	  }
	| { type: "thinking"; data: { text: string } }
	| { type: "text"; data: { text: string } }
	/** A Classroom tool started or finished, for a "Consultando turmas…" indicator. */
	| { type: "tool"; data: { name: string; status: "running" | "done" | "error" } }
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
