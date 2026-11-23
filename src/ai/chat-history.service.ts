import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { conversationsTable } from "../db/schemas/conversation.js";
import { documentsTable } from "../db/schemas/document.js";
import { type MessageMetadata, messagesTable } from "../db/schemas/message.js";
import { ragDocumentsTable } from "../db/schemas/rag-document.js";
import type {
	ChatDetail,
	ChatMessageAttachment,
	ChatMessageDocument,
	ChatMessageView,
} from "./dto/chat-detail.dto.js";
import type { ChatListItem, ChatListPage, GetChatsDto } from "./dto/get-chats.dto.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Full microsecond precision, so a cursor never skips rows that share a millisecond.
const CURSOR_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;

const listColumns = {
	id: conversationsTable.id,
	title: conversationsTable.title,
	createdAt: conversationsTable.createdAt,
	updatedAt: conversationsTable.updatedAt,
};

interface ConversationDocumentRow {
	id: string;
	type: ChatMessageDocument["documentType"];
	version: number;
	title: string | null;
}

interface Cursor {
	updatedAt: string;
	id: string;
}

/**
 * The user's chats: the list, one chat with its messages, rename and delete.
 * A chat that is missing or belongs to someone else is a 404 either way, so
 * the response never reveals that it exists.
 */
@Injectable()
export class ChatHistoryService {
	constructor(@InjectDrizzle() private readonly db: NodePgDatabase) {}

	/** Most recently active first; keyset pagination on (updatedAt, id). */
	async list(userId: string, query: GetChatsDto): Promise<ChatListPage> {
		const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);

		const rows = await this.db
			.select({
				...listColumns,
				cursorAt: sql<string>`to_char(${conversationsTable.updatedAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
			})
			.from(conversationsTable)
			.where(
				and(
					eq(conversationsTable.userId, userId),
					cursor
						? sql`(${conversationsTable.updatedAt}, ${conversationsTable.id}) < (${cursor.updatedAt}::timestamp, ${cursor.id}::uuid)`
						: undefined,
				),
			)
			.orderBy(desc(conversationsTable.updatedAt), desc(conversationsTable.id))
			.limit(query.limit + 1);

		const hasMore = rows.length > query.limit;
		const page = hasMore ? rows.slice(0, query.limit) : rows;
		const last = page.at(-1);

		return {
			items: page.map((row) => ({
				id: row.id,
				title: row.title,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
			})),
			nextCursor: hasMore && last ? encodeCursor({ updatedAt: last.cursorAt, id: last.id }) : null,
		};
	}

	/** The chat with all its messages, oldest first. */
	async get(conversationId: string, userId: string): Promise<ChatDetail> {
		const conversation = await this.findOwned(conversationId, userId);

		const [messages, attachments, documents] = await Promise.all([
			this.db
				.select({
					id: messagesTable.id,
					role: messagesTable.role,
					content: messagesTable.content,
					createdAt: messagesTable.createdAt,
					status: messagesTable.status,
					metadata: messagesTable.metadata,
				})
				.from(messagesTable)
				.where(eq(messagesTable.conversationId, conversation.id))
				.orderBy(asc(messagesTable.createdAt), asc(messagesTable.id)),
			this.db
				.select({
					id: ragDocumentsTable.id,
					messageId: ragDocumentsTable.messageId,
					name: ragDocumentsTable.filename,
					type: ragDocumentsTable.mimeType,
				})
				.from(ragDocumentsTable)
				.where(
					and(
						eq(ragDocumentsTable.userId, userId),
						eq(ragDocumentsTable.conversationId, conversation.id),
						isNotNull(ragDocumentsTable.messageId),
					),
				)
				.orderBy(asc(ragDocumentsTable.createdAt)),
			this.db
				.select({
					id: documentsTable.id,
					type: documentsTable.type,
					version: documentsTable.version,
					title: sql<string | null>`${documentsTable.document}->'content'->>'title'`,
				})
				.from(documentsTable)
				.where(
					and(
						eq(documentsTable.userId, userId),
						eq(documentsTable.conversationId, conversation.id),
					),
				),
		]);

		const attachmentsByMessage = new Map<string, ChatMessageAttachment[]>();
		for (const { messageId, ...attachment } of attachments) {
			if (!messageId) continue;
			const list = attachmentsByMessage.get(messageId) ?? [];
			list.push(attachment);
			attachmentsByMessage.set(messageId, list);
		}

		const documentsById = new Map(documents.map((document) => [document.id, document]));

		return {
			...conversation,
			messages: messages.map((message): ChatMessageView => {
				if (message.role === "USER") {
					return {
						id: message.id,
						role: "user",
						text: message.content ?? "",
						createdAt: message.createdAt,
						status: null,
						thinking: null,
						model: null,
						documents: [],
						attachments: attachmentsByMessage.get(message.id) ?? [],
						tools: [],
					};
				}

				const metadata = message.metadata;
				return {
					id: message.id,
					role: "assistant",
					text: message.content ?? "",
					createdAt: message.createdAt,
					status: message.status,
					thinking: metadata?.thinking ?? null,
					model: metadata
						? {
								tier: metadata.tier,
								selection: metadata.selection ?? null,
								thinkingLevel: metadata.thinkingOption ?? null,
								downgradedFrom: metadata.downgradedFrom ?? null,
								upgradedFrom: metadata.upgradedFrom ?? null,
							}
						: null,
					documents: turnDocuments(metadata, documentsById),
					attachments: [],
					tools: (metadata?.tools ?? []).map(({ name, ok }) => ({ name, ok })),
				};
			}),
		};
	}

	/** Renaming does not move the chat in the list: only activity does. */
	async rename(conversationId: string, userId: string, title: string): Promise<ChatListItem> {
		if (!UUID_PATTERN.test(conversationId)) {
			throw chatNotFound();
		}

		const [updated] = await this.db
			.update(conversationsTable)
			.set({ title, updatedAt: sql`${conversationsTable.updatedAt}` })
			.where(and(eq(conversationsTable.id, conversationId), eq(conversationsTable.userId, userId)))
			.returning(listColumns);

		if (!updated) {
			throw chatNotFound();
		}

		return updated;
	}

	/** Messages go with the chat (FK cascade); documents made in it only when asked. */
	async delete(conversationId: string, userId: string, deleteDocuments: boolean): Promise<void> {
		if (!UUID_PATTERN.test(conversationId)) {
			throw chatNotFound();
		}

		await this.db.transaction(async (tx) => {
			const [deleted] = await tx
				.delete(conversationsTable)
				.where(and(eq(conversationsTable.id, conversationId), eq(conversationsTable.userId, userId)))
				.returning({ id: conversationsTable.id });

			if (!deleted) {
				throw chatNotFound();
			}

			if (deleteDocuments) {
				await tx
					.delete(documentsTable)
					.where(
						and(
							eq(documentsTable.userId, userId),
							eq(documentsTable.conversationId, conversationId),
						),
					);
			}
		});
	}

	private async findOwned(conversationId: string, userId: string): Promise<ChatListItem> {
		if (!UUID_PATTERN.test(conversationId)) {
			throw chatNotFound();
		}

		const [conversation] = await this.db
			.select(listColumns)
			.from(conversationsTable)
			.where(and(eq(conversationsTable.id, conversationId), eq(conversationsTable.userId, userId)));

		if (!conversation) {
			throw chatNotFound();
		}

		return conversation;
	}
}

/** The document a turn created or changed, while it still exists. */
function turnDocuments(
	metadata: MessageMetadata | null,
	documentsById: Map<string, ConversationDocumentRow>,
): ChatMessageDocument[] {
	const turn = metadata?.document;
	if (!turn || turn.action === "ASK_HEADER" || !turn.ok || !turn.id) {
		return [];
	}

	const document = documentsById.get(turn.id);
	if (!document) {
		return [];
	}

	return [
		{
			id: document.id,
			documentType: document.type,
			action: turn.action,
			title: document.title ?? "Sem título",
			version: document.version,
		},
	];
}

function chatNotFound(): NotFoundException {
	return new NotFoundException("Chat not found");
}

function encodeCursor(cursor: Cursor): string {
	return Buffer.from(`${cursor.updatedAt}|${cursor.id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor {
	const [updatedAt, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|");

	if (
		rest.length > 0 ||
		!updatedAt ||
		!id ||
		!CURSOR_TIMESTAMP_PATTERN.test(updatedAt) ||
		!UUID_PATTERN.test(id)
	) {
		throw new BadRequestException("Invalid cursor");
	}

	return { updatedAt, id };
}
