import { Injectable } from '@nestjs/common';
import { AiExpensesFactory, AIExpense } from './ai.factory.js';

@Injectable()
export class AiService {
  constructor(private readonly aiFactory: AiExpensesFactory) {}

  async chat(expense: AIExpense, prompt: string) {
    const provider = this.aiFactory.create(expense);
    return provider.generate({ message: prompt });
  }
}
