import { z } from "zod";

const MB = 1024 * 1024;

/** User-facing thinking levels, ordered low → high. Mapped to Gemini levels in the AI layer. */
export const THINKING_LEVELS = ["DEFAULT", "HIGH", "ULTRA_HIGH"] as const;
export type ThinkingLevelOption = (typeof THINKING_LEVELS)[number];

export const USAGE_CYCLES = ["WEEKLY", "MONTHLY"] as const;
export type UsageCycleKind = (typeof USAGE_CYCLES)[number];

const perCycle = z.number().int().nonnegative().nullable();

/**
 * Shape of `plans.limits`. Edited by hand in the DB, so it is parsed on read.
 * `null` means unlimited.
 */
export const planLimitsSchema = z.object({
	cycle: z.enum(USAGE_CYCLES),
	uploadsPerCycle: perCycle,
	maxFileBytes: z.number().int().positive(),
	/** Total across all documents, not per cycle. */
	storageBytes: z.number().int().nonnegative().nullable(),
	messagesPerCycle: z.object({
		cheap: perCycle,
		normal: perCycle,
		expensive: perCycle,
	}),
	maxThinkingLevel: z.enum(THINKING_LEVELS),
	/** AI-generated documents (assessments). 0 turns the feature off. */
	documentsPerCycle: perCycle,
	/**
	 * AI changes (revise/regenerate) included with each document credit. The
	 * next change after each block spends one more credit. `null` = unlimited.
	 */
	aiChangesPerDocument: z.number().int().positive().nullable(),
});

export type PlanLimits = z.infer<typeof planLimitsSchema>;

/** Static multer ceiling; each plan's `maxFileBytes` is still enforced by UsageService. */
export const MAX_UPLOAD_BYTES = 50 * MB;

/** Slug of the plan used when the user has no live subscription. */
export const FREE_PLAN_SLUG = "free";

/** Whether `requested` is at or below the plan's `max`. */
export function isThinkingLevelAllowed(
	requested: ThinkingLevelOption,
	max: ThinkingLevelOption,
): boolean {
	return THINKING_LEVELS.indexOf(requested) <= THINKING_LEVELS.indexOf(max);
}
