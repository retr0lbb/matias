import { BadRequestException, ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { desc, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { conversationsTable } from '../db/schemas/conversation.js';
import { messagesTable } from '../db/schemas/message.js';
import { userTable } from '../db/schemas/user.js';
import { RagSearchResult, RagService } from '../rag/rag.service.js';
import { QuotaExceededException, type QuotaExceededBody } from '../usage/quota-exceeded.exception.js';
import { UsageService } from '../usage/usage.service.js';
import type { AIResponse } from './ai-provider.type.js';
import { AIExpense, AiExpensesFactory } from './ai.factory.js';
import type { ChatStreamEvent } from './dto/chat-stream-event.js';
import { JudgeModel } from './models/judge-model.js';

const HISTORY_LIMIT = 20;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatStreamContext {
  user: typeof userTable.$inferSelect;
  prompt: string;
  conversation: { id: string; title: string | null };
  /** RAG only runs when the client sent a conversationId (same rule as chat()). */
  ragEnabled: boolean;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly aiFactory: AiExpensesFactory,
    @InjectDrizzle() private readonly db: NodePgDatabase,
    private readonly ragService: RagService,
    private readonly usageService: UsageService,
    private readonly judgeModel: JudgeModel
  ) {}


  async chat(prompt: string, loggedUser: string, conversationId?: string) {
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

    const history = (
      await this.db.select({
        role: messagesTable.role,
        content: messagesTable.content,
      })
        .from(messagesTable)
        .where(eq(messagesTable.conversationId, conversation.id))
        .orderBy(desc(messagesTable.createdAt))
        .limit(HISTORY_LIMIT)
    ).reverse()

    const judgeResponse = await this.judgeModel.classify(prompt, history)
    
    console.log("JUDGE RESPONSE =================")
    console.log(judgeResponse)
    
    await this.usageService.assertCanChat(user, judgeResponse.model)

    if (judgeResponse.title && !conversation.title) {
      await this.db.update(conversationsTable)
        .set({ title: judgeResponse.title })
        .where(eq(conversationsTable.id, conversation.id))

      conversation.title = judgeResponse.title
    }

    const chunks: RagSearchResult[] =
      judgeResponse.retrieve && conversationId
        ? await this.retrieveContext(prompt, loggedUser, conversation.id)
        : []

    const input = buildRagPrompt(prompt, chunks, history)

    await this.db.insert(messagesTable).values({
      conversationId: conversation.id,
      role: "USER",
      content: prompt
    })

    const provider = this.aiFactory.create(judgeResponse.model as AIExpense);

    this.logger.log(`[RAG] retrieve=${judgeResponse.retrieve} conversationId=${conversationId}`)
    const message = await provider.generate({ message: input });

    await this.db.insert(messagesTable).values({
      conversationId: conversation.id,
      role: "IA",
      content: message.output_text,
      inputTokens: message.usage.total_input_tokens,
      outputTokens: message.usage.total_tokens,
      interactionId: message.messageId,
      expense: judgeResponse.model,
    })

    return message.output_text
  }

  /**
   * Cheap checks that must fail with a real HTTP status (401/400/403), run
   * before the controller switches the response to SSE. The slow work (judge,
   * usage, RAG) happens inside streamAnswer so the client gets bytes right away.
   */
  async prepareStream(
    prompt: string,
    loggedUser: string,
    conversationId?: string,
  ): Promise<ChatStreamContext> {

    const [user] = await this.db.select()
      .from(userTable)
      .where(eq(userTable.id, loggedUser))

    if (!user) {
      throw new UnauthorizedException("User not authenticated properly")
    }

    let conversation: { id: string; userId: string; title: string | null }

    if (conversationId) {
      if (!UUID_PATTERN.test(conversationId)) {
        throw new BadRequestException("conversationId must be a UUID")
      }

      const [foundConversation] = await this.db.select()
        .from(conversationsTable)
        .where(eq(conversationsTable.id, conversationId))

      if (foundConversation && foundConversation.userId !== loggedUser) {
        throw new ForbiddenException("Not your chat pal")
      }

      if (foundConversation) {
        conversation = foundConversation
      } else {
        // Clients can pre-generate the conversation id so documents uploaded
        // with that id are found when the chat starts.
        const [newConversation] = await this.db.insert(conversationsTable).values({
          id: conversationId,
          userId: loggedUser,
        }).returning()

        conversation = newConversation
      }
    } else {
      const [newConversation] = await this.db.insert(conversationsTable).values({
        userId: loggedUser,
      }).returning()

      conversation = newConversation
    }

    return {
      user,
      prompt,
      conversation: { id: conversation.id, title: conversation.title },
      ragEnabled: Boolean(conversationId),
    }
  }

  /**
   * Streams the answer for a prepared chat. Never throws: failures become an
   * `error` event. The IA message is saved when the stream ends, with partial
   * text if the client aborted (FAILED) or generation broke (ERROR).
   */
  async *streamAnswer(
    ctx: ChatStreamContext,
    signal: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent> {

    let partial = ""
    let final: AIResponse | undefined
    let model: AIExpense | undefined
    let status: "COMPLETED" | "FAILED" | "ERROR" = "FAILED"

    yield {
      type: "start",
      data: { conversationId: ctx.conversation.id, title: ctx.conversation.title },
    }

    try {
      yield { type: "status", data: { stage: "classifying" } }

      const history = (
        await this.db.select({
          role: messagesTable.role,
          content: messagesTable.content,
        })
          .from(messagesTable)
          .where(eq(messagesTable.conversationId, ctx.conversation.id))
          .orderBy(desc(messagesTable.createdAt))
          .limit(HISTORY_LIMIT)
      ).reverse()

      const judgeResponse = await this.judgeModel.classify(ctx.prompt, history)

      await this.usageService.assertCanChat(ctx.user, judgeResponse.model)

      if (judgeResponse.title && !ctx.conversation.title) {
        await this.db.update(conversationsTable)
          .set({ title: judgeResponse.title })
          .where(eq(conversationsTable.id, ctx.conversation.id))

        ctx.conversation.title = judgeResponse.title
      }

      let chunks: RagSearchResult[] = []
      if (judgeResponse.retrieve && ctx.ragEnabled) {
        yield { type: "status", data: { stage: "retrieving" } }
        chunks = await this.retrieveContext(ctx.prompt, ctx.user.id, ctx.conversation.id)
      }

      const input = buildRagPrompt(ctx.prompt, chunks, history)

      await this.db.insert(messagesTable).values({
        conversationId: ctx.conversation.id,
        role: "USER",
        content: ctx.prompt,
      })

      model = judgeResponse.model as AIExpense
      const provider = this.aiFactory.create(model)

      yield {
        type: "status",
        data: { stage: "generating", model, title: ctx.conversation.title },
      }
      for await (const chunk of provider.generateStream({ message: input, signal })) {

        if (chunk.type === "text") {
          partial += chunk.text
          yield { type: "text", data: { text: chunk.text } }
        } else if (chunk.type === "thinking") {
          yield { type: "thinking", data: { text: chunk.text } }
        } else {
          final = chunk.response
        }
      }

      if (final) {
        status = "COMPLETED"
        yield {
          type: "done",
          data: {
            messageId: final.messageId,
            finishReason: final.status,
            usage: final.usage,
          },
        }
      }
    } catch (error) {
      if (signal.aborted) {
        status = "FAILED"
        this.logger.warn(`[STREAM] client aborted conversation=${ctx.conversation.id}`)
      } else if (error instanceof QuotaExceededException) {
        status = "ERROR"
        yield { type: "error", data: error.getResponse() as QuotaExceededBody }
      } else {
        status = "ERROR"
        this.logger.error(`[STREAM] generation failed conversation=${ctx.conversation.id}`, error)
        yield { type: "error", data: { code: "GENERATION_FAILED", message: "Generation failed" } }
      }
    } finally {
      if (model) {
        await this.saveStreamedMessage(ctx, model, final?.output_text ?? partial, final, status)
      }
    }
  }

  private async saveStreamedMessage(
    ctx: ChatStreamContext,
    model: AIExpense,
    content: string,
    final: AIResponse | undefined,
    status: "COMPLETED" | "FAILED" | "ERROR",
  ): Promise<void> {
    if (content.length === 0) {
      return
    }

    try {
      await this.db.insert(messagesTable).values({
        conversationId: ctx.conversation.id,
        role: "IA",
        content,
        inputTokens: final?.usage.total_input_tokens ?? 0,
        outputTokens: final?.usage.total_tokens ?? 0,
        interactionId: final?.messageId || null,
        expense: model,
        status,
      })
    } catch (error) {
      this.logger.error(`[STREAM] failed to save IA message conversation=${ctx.conversation.id}`, error)
    }
  }

  private async retrieveContext(prompt: string, userId: string, conversationId: string) {
    try {
      const ready = await this.ragService.hasReadyDocuments(userId, conversationId)
      this.logger.log(`[RAG] conversation=${conversationId} ready=${ready}`)
      if (!ready) return []

      const results = await this.ragService.search(prompt, userId, { conversationId })
      this.logger.log(`[RAG] results=${results.length}`)
      return results
    } catch (error) {
      this.logger.error("[RAG] search failed", error)
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
