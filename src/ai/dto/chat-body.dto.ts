import { z } from "zod";
import { THINKING_LEVELS } from "../../usage/plan-limits.js";

export const chatBodySchema = z.object({
	prompt: z.string(),
	/** AUTO lets the judge pick. Frontend labels: CHEAP=Default, NORMAL=Expert, EXPENSIVE=Doctor. */
	model: z.enum(["AUTO", "CHEAP", "NORMAL", "EXPENSIVE"]).default("AUTO"),
	/** Must be within the plan's maxThinkingLevel, or the request gets a 403. */
	thinkingLevel: z.enum(THINKING_LEVELS).default("DEFAULT"),
});

export type ChatBody = z.infer<typeof chatBodySchema>;
export type ChatOptions = Pick<ChatBody, "model" | "thinkingLevel">;
