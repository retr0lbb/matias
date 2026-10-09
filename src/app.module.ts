import { Module } from '@nestjs/common';
import { RouterModule } from './router/router.module.js';
import { AiModule } from './ai/ai.module.js';
import { RagModule } from './rag/rag.module.js';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    RouterModule, 
    AiModule, 
    RagModule,
    ConfigModule.forRoot({
      isGlobal: true
    })
  ]
})
export class AppModule {}
