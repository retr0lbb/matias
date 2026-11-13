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
import { PaymentService } from "../../payment/payment.service.js";
import { asaasWebhookSchema } from "../dto/asaas-webhook.dto.js";
import { SubscriptionService } from "../subscription.service.js";

// PIX goes straight to RECEIVED; a card is CONFIRMED first and only becomes
// RECEIVED about a month later, so both mean "paid".
const PAID_EVENTS = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"]);

// The subscription is still live, just waiting for the money.
const PAST_DUE_EVENTS = new Set(["PAYMENT_OVERDUE"]);

// The money went back or the subscription ended on Asaas: the plan is lost.
const ENDED_EVENTS = new Set([
	"PAYMENT_REFUNDED",
	"PAYMENT_CHARGEBACK_REQUESTED",
	"SUBSCRIPTION_INACTIVATED",
	"SUBSCRIPTION_DELETED",
]);

// Worth a warning, but not enough to change the subscription: a deleted charge
// does not end it, and a refused card becomes PAYMENT_OVERDUE if left unpaid.
const WATCHED_EVENTS = new Set(["PAYMENT_DELETED", "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED"]);

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
	async handle(@Headers() headers: any | undefined, @Body() body: unknown) {
		if (!this.paymentService.isValidWebhookToken(headers["asaas-access-token"])) {
			throw new UnauthorizedException("BLOCKED FROM ASAAS");
		}

		const parsed = asaasWebhookSchema.safeParse(body);
		if (!parsed.success) {
			this.logger.warn("Ignoring Asaas webhook with an unexpected body");
			return { received: true };
		}

		const { event, payment, subscription } = parsed.data;
		// Our local subscription id, and the Asaas one as a fallback for charges
		// that lost the reference (edited on the Asaas panel, for instance).
		const reference = payment?.externalReference ?? subscription?.externalReference;
		const asaasSubscriptionId = payment?.subscription ?? subscription?.id;
		const subject = payment?.id ?? subscription?.id ?? "an unidentified object";

		if (PAID_EVENTS.has(event)) {
			if (!payment) return { received: true };

			const activated = await this.subService.activateFromPayment(reference, asaasSubscriptionId);
			// Not a first payment: it may be the late payment of an overdue charge.
			const reactivated =
				!activated && (await this.subService.reactivatePastDue(reference, asaasSubscriptionId));

			let outcome = "nothing to activate";
			if (activated) outcome = "subscription activated";
			else if (reactivated) outcome = "past due subscription reactivated";
			this.logger.log(`${event} for ${subject}: ${outcome}`);
		} else if (PAST_DUE_EVENTS.has(event)) {
			const marked = await this.subService.markPastDue(reference, asaasSubscriptionId);
			this.logger.warn(
				`${event} for ${subject}: ${marked ? "subscription marked as past due" : "no active subscription to mark"}`,
			);
		} else if (ENDED_EVENTS.has(event)) {
			const ended = await this.subService.deactivate(reference, asaasSubscriptionId, event);
			this.logger.warn(
				`${event} for ${subject}: ${ended ? "subscription deactivated" : "no live subscription to deactivate"}`,
			);
		} else if (WATCHED_EVENTS.has(event)) {
			this.logger.warn(`${event} for ${subject}: no change made to the subscription`);
		}

		return { received: true };
	}
}
