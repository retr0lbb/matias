import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AiController } from "./ai.controller.js";
import { AiService } from "./ai.service.js";
import { AiExpensesFactory } from "./ai.factory.js";
import { ConversationModule } from "../conversation/conversation.module.js";
import { UsageModule } from "../usage/usage.module.js";
import { JudgeModel } from "./models/judge-model.js";

@Module({
	imports: [ConfigModule, ConversationModule, UsageModule],
	controllers: [AiController],
	providers: [AiService, AiExpensesFactory, JudgeModel],
	exports: [AiService, AiExpensesFactory],
})
export class AiModule {}
