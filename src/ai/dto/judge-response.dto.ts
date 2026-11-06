import z from "zod/v4";

export const TOOL_NAMES = [
	"classroom.list_classrooms",
	"classroom.list_students",
	"classroom.get_assignments",
] as const;

export const judgeReponseSchema = z.object({
	model: z.enum(["CHEAP", "NORMAL", "EXPENSIVE"]),
	retrieve: z.boolean(),
	tools: z.array(z.enum(TOOL_NAMES)),
	title: z.string().optional(),
});

export type JudgeReponse = z.infer<typeof judgeReponseSchema>;
