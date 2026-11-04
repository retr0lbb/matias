import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { AiExpensesFactory, AIExpense } from './ai.factory.js';
import { InjectDrizzle } from '@nestjs/drizzle';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { userTable } from '../db/schemas/user.js';
import { eq } from 'drizzle-orm';
import { conversationsTable } from '../db/schemas/conversation.js';
import { messagesTable } from '../db/schemas/message.js';

@Injectable()
export class AiService {
  constructor(
    private readonly aiFactory: AiExpensesFactory,
    @InjectDrizzle() private readonly db: NodePgDatabase
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
        const [foundConversation] = await this.db.select()
      .from(conversationsTable)
      .where(
        eq(conversationsTable.id, conversationId)
      )

      if(foundConversation.userId !== loggedUser){
        throw new ForbiddenException("Not your chat pal")
      }

      conversation = foundConversation
    }else{
        const [newConversation] = await this.db.insert(conversationsTable).values({
          userId: loggedUser
        }).returning()

        conversation = newConversation
    }

    await this.db.insert(messagesTable).values({
      conversationId: conversation.id,
      role: "USER",
      content: prompt
    })

    const provider = this.aiFactory.create(expense);
    const message = await provider.generate({ message: prompt });

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
}
