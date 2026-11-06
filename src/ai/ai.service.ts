import { BadRequestException, ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { desc, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { conversationsTable } from '../db/schemas/conversation.js';
import { messagesTable } from '../db/schemas/message.js';
import { userTable } from '../db/schemas/user.js';
import { RagSearchResult, RagService } from '../rag/rag.service.js';
import { UsageService } from '../usage/usage.service.js';
import { AIExpense, AiExpensesFactory } from './ai.factory.js';
import { JudgeModel } from './models/judge-model.js';

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
