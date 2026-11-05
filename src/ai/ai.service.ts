import { BadRequestException, ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { AiExpensesFactory, AIExpense } from './ai.factory.js';
import { InjectDrizzle } from '@nestjs/drizzle';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { userTable } from '../db/schemas/user.js';
import { desc, eq } from 'drizzle-orm';
import { conversationsTable } from '../db/schemas/conversation.js';
import { messagesTable } from '../db/schemas/message.js';
import { RagService, type RagSearchResult } from '../rag/rag.service.js';

const HISTORY_LIMIT = 20;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly aiFactory: AiExpensesFactory,
    @InjectDrizzle() private readonly db: NodePgDatabase,
    private readonly ragService: RagService,
  ) {}

  async chat(expense: AIExpense, prompt: string, loggedUser: string, conversationId?: string) {
    const [user] = await this.db.select()
      .from(userTable)
      .where(
        eq(userTable.id, loggedUser)
      )

    if(!user){
      throw new UnauthorizedException("User not authenticated properly")
    }

    let conversation: {
      title: string | null;
      id: string;
      userId: string;
      createdAt: Date;
      updatedAt: Date | null;
    }

    if(conversationId){
      if(!UUID_PATTERN.test(conversationId)){
        throw new BadRequestException("conversationId must be a UUID")
      }

      const [foundConversation] = await this.db.select()
        .from(conversationsTable)
        .where(
          eq(conversationsTable.id, conversationId)
        )

      if(foundConversation && foundConversation.userId !== loggedUser){
        throw new ForbiddenException("Not your chat pal")
      }

      if(foundConversation){
        conversation = foundConversation
      }else{
        // Clients can pre-generate the conversation id so documents uploaded
        // with that id are found when the chat starts.
        const [newConversation] = await this.db.insert(conversationsTable).values({
          id: conversationId,
          userId: loggedUser
        }).returning()

        conversation = newConversation
      }
    }else{
      const [newConversation] = await this.db.insert(conversationsTable).values({
        userId: loggedUser
      }).returning()

      conversation = newConversation
    }

    // History and retrieval are independent; run them together.
    // A conversation created just now cannot have documents yet.
    const [history, chunks] = await Promise.all([
      this.db.select({
        role: messagesTable.role,
        content: messagesTable.content,
      })
        .from(messagesTable)
        .where(eq(messagesTable.conversationId, conversation.id))
        .orderBy(desc(messagesTable.createdAt))
        .limit(HISTORY_LIMIT),
      conversationId
        ? this.retrieveContext(prompt, loggedUser, conversation.id)
        : Promise.resolve([]),
    ])

    const input = buildRagPrompt(prompt, chunks, history.reverse())

    await this.db.insert(messagesTable).values({
      conversationId: conversation.id,
      role: "USER",
      content: prompt
    })

    const provider = this.aiFactory.create(expense);
    const message = await provider.generate({ message: input });

    await this.db.insert(messagesTable).values({
      conversationId: conversation.id,
      role: "IA",
      content: message.output_text,
      inputTokens: message.usage.total_input_tokens,
      outputTokens: message.usage.total_tokens,
      interactionId: message.messageId,
    })

    return message.output_text
  }

  // Retrieval is best-effort: an embedding failure (e.g. quota) should not
  // take down the chat. Conversations without READY documents skip the query
  // embedding call entirely.
  private async retrieveContext(
    prompt: string,
    userId: string,
    conversationId: string,
  ): Promise<RagSearchResult[]> {
    try {
      if (!(await this.ragService.hasReadyDocuments(userId, conversationId))) {
        return []
      }

      return await this.ragService.search(prompt, userId, { conversationId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(`RAG search failed, answering without context: ${message}`)
      return []
    }
  }
}

function buildRagPrompt(
  prompt: string,
  chunks: RagSearchResult[],
  history: Array<{ role: string; content: string | null }>,
): string {
  const sections = [
    "You are a helpful assistant. Answer the user using the context below when it is relevant. If the context does not contain the answer, say so and answer from general knowledge.",
  ]

  if (chunks.length > 0) {
    sections.push(
      "Context:\n" +
        chunks
          .map(
            (chunk, index) =>
              `[${index + 1}] ${chunk.filename}\n${chunk.content}`,
          )
          .join("\n\n"),
    )
  }

  if (history.length > 0) {
    sections.push(
      "Conversation history:\n" +
        history
          .map((message) => `${message.role}: ${message.content ?? ""}`)
          .join("\n"),
    )
  }

  sections.push(`User: ${prompt}`)

  return sections.join("\n\n")
}
