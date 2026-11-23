import z from "zod/v4";

export const renameChatSchema = z.object({
	newTitle: z.string().min(3).max(256).nonempty(),
});
