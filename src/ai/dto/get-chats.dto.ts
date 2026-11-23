import z from "zod/v4";

export const CHAT_LIST_DEFAULT_LIMIT = 30;
export const CHAT_LIST_MAX_LIMIT = 100;

/** `GET /ai/chat?limit=30&cursor=<nextCursor>`. */
export const getChatsDtoSchema = z.object({
	limit: z.coerce.number().int().min(1).max(CHAT_LIST_MAX_LIMIT).default(CHAT_LIST_DEFAULT_LIMIT),
	/** Opaque: the `nextCursor` of the previous page. */
	cursor: z.string().min(1).optional(),
});

export type GetChatsDto = z.infer<typeof getChatsDtoSchema>;

export interface ChatListItem {
	id: string;
	title: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface ChatListPage {
	items: ChatListItem[];
	/** Null on the last page. */
	nextCursor: string | null;
}
