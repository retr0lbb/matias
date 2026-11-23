/**
 * Every Gemini model the app calls, in one place. Keys match `AIExpense`
 * (spelled out here so this file imports nothing and cannot form a cycle).
 */
export type ModelTier = "CHEAP" | "NORMAL" | "EXPENSIVE";

export const MODEL_IDS: Record<ModelTier, string> = {
	CHEAP: "gemini-3.5-flash",
	NORMAL: "gemini-3.8-flash",
	EXPENSIVE: "gemini-3.8-flash",
};

/** Routes each chat turn (tier, retrieval, tools, document intent, title). */
export const JUDGE_MODEL_ID = "gemini-3.1-flash-lite";

/** Output budget of a chat answer per tier. */
export const CHAT_MAX_OUTPUT_TOKENS: Record<ModelTier, number> = {
	CHEAP: 2048,
	NORMAL: 2048,
	EXPENSIVE: 4096,
};

/** Cheapest first: a document turn may move a tier up, never down below its minimum. */
export const TIERS_BY_COST: ModelTier[] = ["CHEAP", "NORMAL", "EXPENSIVE"];

/** The bigger of two tiers. */
export function maxTier(a: ModelTier, b: ModelTier): ModelTier {
	return TIERS_BY_COST.indexOf(a) >= TIERS_BY_COST.indexOf(b) ? a : b;
}
