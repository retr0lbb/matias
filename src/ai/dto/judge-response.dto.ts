import z from "zod/v4";

export const TOOL_NAMES = [
	"classroom.list_classrooms",
	"classroom.list_students",
	"classroom.get_assignments",
] as const;

export const JUDGE_MODELS = ["CHEAP", "NORMAL", "EXPENSIVE"] as const;

/** Judge output when the user picked the model: no routing, just retrieval/tools/title. */
export const judgeReponseSchema = z.object({
	retrieve: z.boolean(),
	tools: z.array(z.enum(TOOL_NAMES)),
	title: z.string().optional(),
});

/** Judge output in AUTO mode: also chooses the model tier. */
export const routedJudgeReponseSchema = judgeReponseSchema.extend({
	model: z.enum(JUDGE_MODELS),
});

export type JudgeReponse = z.infer<typeof judgeReponseSchema>;
export type RoutedJudgeReponse = z.infer<typeof routedJudgeReponseSchema>;
