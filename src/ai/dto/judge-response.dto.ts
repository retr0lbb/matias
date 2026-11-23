import z from "zod/v4";
import { CLASSROOM_TOOL_NAMES } from "../../classroom/classroom-tool-names.js";
import { DOCUMENT_TYPES } from "../../documents/types/document-type.js";
import { AI_HEADER_FIELDS } from "../../documents/schemas/header.schema.js";

export const TOOL_NAMES = CLASSROOM_TOOL_NAMES;

export const JUDGE_MODELS = ["CHEAP", "NORMAL", "EXPENSIVE"] as const;

export const DOCUMENT_ACTIONS = ["NONE", "CREATE", "REVISE", "REGENERATE"] as const;
export type DocumentAction = (typeof DOCUMENT_ACTIONS)[number];

/** STANDARD runs on NORMAL, ADVANCED on EXPENSIVE (see AiService.planTurn). */
export const DOCUMENT_COMPLEXITIES = ["STANDARD", "ADVANCED"] as const;
export type DocumentComplexity = (typeof DOCUMENT_COMPLEXITIES)[number];

const NO_DOCUMENT = { action: "NONE" as const, missingHeader: [] };

/**
 * What the judge decided about documents this turn. A malformed answer reads
 * as NONE, so a bad document field never breaks a normal chat turn.
 */
export const judgeDocumentSchema = z
	.object({
		action: z.enum(DOCUMENT_ACTIONS),
		type: z.enum(DOCUMENT_TYPES).optional(),
		/** REVISE / REGENERATE: id of a document listed in the judge prompt. Checked by AiService. */
		targetId: z.string().optional(),
		complexity: z.enum(DOCUMENT_COMPLEXITIES).optional(),
		/** CREATE: header fields the teacher has not given anywhere in the conversation. */
		missingHeader: z.array(z.enum(AI_HEADER_FIELDS)).default([]),
	})
	.catch(NO_DOCUMENT);

export type JudgeDocument = z.infer<typeof judgeDocumentSchema>;

/** Judge output when the user picked the model: no routing, just retrieval/tools/document/title. */
export const judgeReponseSchema = z.object({
	retrieve: z.boolean(),
	tools: z.array(z.enum(TOOL_NAMES)),
	document: judgeDocumentSchema.default(NO_DOCUMENT),
	title: z.string().optional(),
});

/** Judge output in AUTO mode: also chooses the model tier. */
export const routedJudgeReponseSchema = judgeReponseSchema.extend({
	model: z.enum(JUDGE_MODELS),
});

export type JudgeReponse = z.infer<typeof judgeReponseSchema>;
export type RoutedJudgeReponse = z.infer<typeof routedJudgeReponseSchema>;
