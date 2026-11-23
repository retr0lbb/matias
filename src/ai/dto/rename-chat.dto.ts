import z from "zod/v4";

/** `PATCH /ai/chat/:id`. */
export const renameChatSchema = z.object({
	title: z.string().trim().min(1).max(256),
});

export type RenameChatDto = z.infer<typeof renameChatSchema>;
