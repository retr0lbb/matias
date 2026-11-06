import { Authenticate, CurrentUser } from '@nestjs/authentication';
import { Body, Controller, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { User } from '../db/schemas/user.js';
import { ZodValidationPipe } from '../shared/pipes/zodValidationPipe.js';
import { AiService } from './ai.service.js';

const chatBodySchema = z.object({
  prompt: z.string()
});

type ChatBody = z.infer<typeof chatBodySchema>;

@Controller('ai/chat')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Authenticate({ verifiedEmail: true })
  @Post()
  //Da pra passar o conversation ID tanto de quey ou de body opcional,
  //Dps ver como lidar com conversation ID invalido e como separar melhor essa funcao
  async chat(@Body(new ZodValidationPipe(chatBodySchema)) body: ChatBody, @CurrentUser() user: User, @Query("conversationId") conversationId: string,) {
    return this.aiService.chat(body.prompt, user.id, conversationId);
  }
}
