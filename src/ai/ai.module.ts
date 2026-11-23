import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AiController } from "./ai.controller.js";
import { AiService } from "./ai.service.js";
import { AiExpensesFactory } from "./ai.factory.js";
import { ClassroomModule } from "../classroom/classroom.module.js";
import { ConversationModule } from "../conversation/conversation.module.js";
import { DocumentsModule } from "../documents/documents.module.js";
import { UsageModule } from "../usage/usage.module.js";
import { DocumentTurnService } from "./document-turn.service.js";
import { GeminiModule } from "./gemini.client.js";
import { JudgeModel } from "./models/judge-model.js";

@Module({
	imports: [
		ConfigModule,
		GeminiModule,
		ConversationModule,
		UsageModule,
		ClassroomModule,
		DocumentsModule,
	],
	controllers: [AiController],
	providers: [AiService, AiExpensesFactory, JudgeModel, DocumentTurnService],
	exports: [AiService, AiExpensesFactory],
})
export class AiModule {}
