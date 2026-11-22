import { Module } from "@nestjs/common";
import { PaymentModule } from "../../../payment/payment.module.js";
import { SubscriptionModule } from "../../../subscription/subscription.module.js";
import { MrBeliargeJob } from "./beliarge.job.js";
import { MrBeliargeService } from "./beliarge.service.js";

@Module({
	imports: [PaymentModule, SubscriptionModule],
	providers: [MrBeliargeService, MrBeliargeJob],
})
export class BeliargeModule {}
