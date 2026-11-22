import { Module } from "@nestjs/common";
import { PaymentModule } from "../../../payment/payment.module.js";
import { SubscriptionModule } from "../../../subscription/subscription.module.js";
import { CountOlafJob } from "./olaf.job.js";
import { CountOlafService } from "./olaf.service.js";

@Module({
	imports: [PaymentModule, SubscriptionModule],
	providers: [CountOlafService, CountOlafJob],
})
export class OlafModule {}
