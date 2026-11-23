import { BadRequestException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { conversationsTable } from "../db/schemas/conversation.js";
import { messagesTable } from "../db/schemas/message.js";
import { type RagSearchResult, RagService } from "../rag/rag.service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConversationRef {
  id: string;
  title: string | null;
}

export interface HistoryMessage {
  role: "USER" | "IA";
  content: string | null;
}

export interface HistoryOptions {
  limit: number;
  /** Only messages created strictly before this moment (regenerate reads the chat as it was). */
  before?: Date;
  /** Leave out IA answers that did not finish (aborted or failed streams are partial). */
  completedOnly?: boolean;
  /** Longer messages are cut, with "…" at the end. */
  maxCharsPerMessage?: number;
  /** Older messages are dropped once the newest ones reach this size. */
  maxTotalChars?: number;
}

export interface RetrieveOptions {
  query: string;
  userId: string;
  conversationId: string;
  /** Default 5 (the chat). */
  limit?: number;
  /** Chunks are kept in similarity order until they reach this size. */
  maxChars?: number;
}

/**
 * The conversation a request belongs to, its history and the documents
 * retrieved for it. The chat stream uses it for every turn, document turns
 * included, so they apply the same ownership rules and see the same history.
 */
@Injectable()
export class ConversationContextService {
  private readonly logger = new Logger(ConversationContextService.name);

  constructor(
    @InjectDrizzle() private readonly db: NodePgDatabase,
    private readonly ragService: RagService,
  ) {}

  /**
   * The user's conversation with this id, created when it doesn't exist yet
   * (clients can pre-generate the id so documents uploaded with it are found
   * when the chat starts). No id = a new conversation.
   */
  async getOrCreate(userId: string, conversationId?: string): Promise<ConversationRef> {
    if (!conversationId) {
      const [created] = await this.db.insert(conversationsTable).values({ userId }).returning();
      return { id: created.id, title: created.title };
    }

    if (!UUID_PATTERN.test(conversationId)) {
      throw new BadRequestException("conversationId must be a UUID");
    }

    const [found] = await this.db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId));

    if (found && found.userId !== userId) {
      throw new ForbiddenException("Not your chat pal");
    }

    if (found) {
      return { id: found.id, title: found.title };
    }

    const [created] = await this.db
      .insert(conversationsTable)
      .values({ id: conversationId, userId })
      .returning();

    return { id: created.id, title: created.title };
  }

  /** Chronological, newest messages kept when something has to be left out. */
  async loadHistory(conversationId: string, options: HistoryOptions): Promise<HistoryMessage[]> {
    const rows = await this.db
      .select({ role: messagesTable.role, content: messagesTable.content })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.conversationId, conversationId),
          options.before ? lt(messagesTable.createdAt, options.before) : undefined,
          // The non-stream chat saves its answers without a status, so null counts as finished.
          options.completedOnly
            ? or(
                eq(messagesTable.role, "USER"),
                isNull(messagesTable.status),
                eq(messagesTable.status, "COMPLETED"),
              )
            : undefined,
        ),
      )
      .orderBy(desc(messagesTable.createdAt))
      .limit(options.limit);

    const { maxCharsPerMessage, maxTotalChars } = options;
    const kept: HistoryMessage[] = [];
    let total = 0;

    for (const row of rows) {
      let content = row.content;
      if (content !== null && maxCharsPerMessage !== undefined && content.length > maxCharsPerMessage) {
        content = `${content.slice(0, maxCharsPerMessage)}…`;
      }

      total += content?.length ?? 0;
      if (maxTotalChars !== undefined && total > maxTotalChars && kept.length > 0) {
        break;
      }
      kept.push({ role: row.role, content });
    }

    return kept.reverse();
  }

  /**
   * Chunks of the conversation's READY documents most similar to `query`.
   * Never throws: a failed search is logged and answered with no chunks.
   */
  async retrieve(options: RetrieveOptions): Promise<RagSearchResult[]> {
    const { query, userId, conversationId } = options;

    try {
      const ready = await this.ragService.hasReadyDocuments(userId, conversationId);
      this.logger.log(`[RAG] conversation=${conversationId} ready=${ready}`);
      if (!ready) return [];

      const results = await this.ragService.search(query, userId, {
        conversationId,
        limit: options.limit,
      });
      this.logger.log(`[RAG] results=${results.length}`);

      return options.maxChars === undefined ? results : capChunks(results, options.maxChars);
    } catch (error) {
      this.logger.error("[RAG] search failed", error);
      return [];
    }
  }
}

function capChunks(results: RagSearchResult[], maxChars: number): RagSearchResult[] {
  const kept: RagSearchResult[] = [];
  let used = 0;

  for (const result of results) {
    if (used + result.content.length > maxChars) {
      break;
    }
    kept.push(result);
    used += result.content.length;
  }

  return kept;
}
