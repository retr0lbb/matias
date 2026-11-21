import { Module } from "@nestjs/common";
import { MrBeliargeController } from "./beliarge.controller.js";
import { MrBeliargeService } from "./beliarge.service.js";

@Module({
	providers: [MrBeliargeService],
	controllers: [MrBeliargeController],
})
export class BeliargeModule {}
