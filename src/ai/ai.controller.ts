import { Body, Controller, Post } from '@nestjs/common';
import { AiService } from './ai.service.js';
import { AIExpense } from './ai.factory.js';
import { CurrentUser } from '@nestjs/authentication';
import { type User } from '../db/schemas/user.js';

@Controller('ai/chat')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post()
  async chat(@Body() body: { expense: AIExpense; prompt: string }, @CurrentUser() user: User) {
    console.log(user)
    return this.aiService.chat(body.expense, body.prompt);
  }
}
