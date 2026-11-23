import z from "zod/v4";

export const getChatsDtoSchema = z.object({});

export type GetChatsDto = z.infer<typeof getChatsDtoSchema>;
