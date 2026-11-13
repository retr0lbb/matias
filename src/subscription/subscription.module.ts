import { Module } from "@nestjs/common";
import { PaymentModule } from "../payment/payment.module.js";
import { SubscriptionController } from "./subscription.controller.js";
import { SubscriptionService } from "./subscription.service.js";
import { AsaasWebhookController } from "./webhooks/asaas-webhook.controller.js";

@Module({
	imports: [PaymentModule],
	controllers: [SubscriptionController, AsaasWebhookController],
	providers: [SubscriptionService],
})
export class SubscriptionModule {}
