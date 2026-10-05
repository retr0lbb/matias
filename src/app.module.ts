import { Module } from '@nestjs/common';
import { RouterModule } from './router/router.module.js';
import { AiModule } from './ai/ai.module.js';
import { RagModule } from './rag/rag.module.js';

@Module({
  imports: [RouterModule, AiModule, RagModule]
})
export class AppModule {}
