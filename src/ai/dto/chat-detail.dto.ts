import type { DocumentTypeName } from "../../db/schemas/document.js";
import type { ThinkingLevelOption } from "../../usage/plan-limits.js";
import type { AIExpense } from "../ai.factory.js";
import type { GeneratedDocumentAction } from "../constants/prompts.js";
import type { ModelSelection } from "./chat-stream-event.js";

/** `GET /ai/chat/:id`. Messages are oldest first. */
export interface ChatDetail {
	id: string;
	title: string | null;
	createdAt: Date;
	updatedAt: Date;
	messages: ChatMessageView[];
}

export interface ChatMessageView {
	id: string;
	role: "user" | "assistant";
	text: string;
	createdAt: Date;
	/** Assistant only. FAILED = the client aborted, ERROR = generation broke; text may be partial. */
	status: "COMPLETED" | "FAILED" | "ERROR" | null;
	/** Assistant only. */
	thinking: string | null;
	/** Assistant only; null for answers saved before metadata existed. */
	model: ChatMessageModel | null;
	/** Assistant only: documents created or changed in this turn. Load each from `GET /documents/:id`. */
	documents: ChatMessageDocument[];
	/** User only: files sent with this message. */
	attachments: ChatMessageAttachment[];
	/** Assistant only: Classroom tools called in this turn. */
	tools: ChatMessageTool[];
}

export interface ChatMessageModel {
	tier: keyof typeof AIExpense;
	selection: ModelSelection | null;
	thinkingLevel: ThinkingLevelOption | null;
	downgradedFrom: keyof typeof AIExpense | null;
	upgradedFrom: keyof typeof AIExpense | null;
}

export interface ChatMessageDocument {
	id: string;
	documentType: DocumentTypeName;
	action: GeneratedDocumentAction;
	/** Current title and version of the document. */
	title: string;
	version: number;
}

export interface ChatMessageAttachment {
	id: string;
	name: string;
	/** MIME type. */
	type: string;
}

export interface ChatMessageTool {
	name: string;
	ok: boolean;
}
