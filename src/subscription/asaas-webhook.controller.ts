import { Public } from "@nestjs/authentication";
import {
	Body,
	Controller,
	Headers,
	HttpCode,
	Logger,
	Post,
	UnauthorizedException,
} from "@nestjs/common";
import { PaymentService } from "../payment/payment.service.js";
import { asaasWebhookSchema } from "./dto/asaas-webhook.dto.js";
import { SubscriptionService } from "./subscription.service.js";

// PIX goes straight to RECEIVED; a card is CONFIRMED first and only becomes
// RECEIVED about a month later, so both mean "paid".
const PAID_EVENTS = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"]);

@Controller("webhooks/asaas")
export class AsaasWebhookController {
	private readonly logger = new Logger(AsaasWebhookController.name);

	constructor(
		private readonly paymentService: PaymentService,
		private readonly subService: SubscriptionService,
	) {}

	/**
	 * Asaas delivers events at least once and pauses the queue after repeated
	 * non-200 answers, so anything we do not handle is acknowledged with 200.
	 */
	@Public()
	@Post("")
	@HttpCode(200)
	async handle(@Headers("asaas-access-token") token: string | undefined, @Body() body: unknown) {
		if (!this.paymentService.isValidWebhookToken(token)) {
			throw new UnauthorizedException("Invalid webhook token");
		}

		const parsed = asaasWebhookSchema.safeParse(body);
		if (!parsed.success) {
			this.logger.warn("Ignoring Asaas webhook with an unexpected body");
			return { received: true };
		}

		const { event, payment } = parsed.data;
		if (PAID_EVENTS.has(event) && payment) {
			const activated = await this.subService.activateFromPayment(payment.externalReference);
			this.logger.log(
				`${event} for ${payment.id}: ${activated ? "subscription activated" : "nothing to activate"}`,
			);
		}

		return { received: true };
	}
}
