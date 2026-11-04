import { Body, Controller, Post, Query } from '@nestjs/common';
import { AiService } from './ai.service.js';
import { AIExpense } from './ai.factory.js';
import { Authenticate, CurrentUser } from '@nestjs/authentication';
import { type User } from '../db/schemas/user.js';

@Controller('ai/chat')
export class AiController {
  constructor(private readonly aiService: AiService) {}
  
  @Authenticate({ verifiedEmail: true })
  @Post()
  //Da pra passar o conversation ID tanto de quey ou de body opcional, 
  //Dps ver como lidar com conversation ID invalido e como separar melhor essa funcao 
  async chat(@Body() body: { expense: AIExpense; prompt: string }, @CurrentUser() user: User, @Query("conversationId") conversationId: string,) {
    return this.aiService.chat(body.expense, body.prompt, user.id, conversationId);
  }
}
