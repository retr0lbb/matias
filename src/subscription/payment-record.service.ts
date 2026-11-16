import { Injectable } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { type PaymentStatus, paymentTables } from "../db/schemas/payments.js";
import { subscriptionTable } from "../db/schemas/subscriptions.js";
import { type AsaasCharge, toPaymentRow } from "./payment-record.js";
import { matchSubscription } from "./subscription-match.js";

const STATUS_BY_EVENT: Record<string, PaymentStatus | undefined> = {
	PAYMENT_CREATED: "PENDING",
	PAYMENT_CONFIRMED: "PAID",
	PAYMENT_RECEIVED: "PAID",
	PAYMENT_OVERDUE: "OVERDUE",
	PAYMENT_REFUNDED: "REFUNDED",
	PAYMENT_CHARGEBACK_REQUESTED: "REFUNDED",
	PAYMENT_DELETED: "FAILED",
	PAYMENT_CREDIT_CARD_CAPTURE_REFUSED: "FAILED",
};

// Events arrive late and out of order, so a stored charge only moves to a
// status from the ones listed here. No entry means "from any status".
const MOVES_FROM: Partial<Record<PaymentStatus, SQL>> = {
	PAID: ne(paymentTables.status, "REFUNDED"),
	OVERDUE: eq(paymentTables.status, "PENDING"),
	FAILED: inArray(paymentTables.status, ["PENDING", "OVERDUE"]),
};

export interface WebhookCharge extends AsaasCharge {
	/** Asaas subscription id (`sub_...`). */
	subscription?: string | null;
	externalReference?: string | null;
}

@Injectable()
export class PaymentRecordService {
	constructor(@InjectDrizzle() private readonly db: NodePgDatabase) {}

	/**
	 * Stores the charge of a webhook event in `payments`, or moves the stored
	 * one to the status the event means. Returns false when nothing was written:
	 * an event we do not track, a charge of no local subscription, a charge
	 * missing required data, or a status change that would go backwards.
	 */
	async recordFromWebhook(event: string, charge: WebhookCharge): Promise<boolean> {
		console.log("SAVING FROM WEBHOOK");
		// Object.hasOwn keeps inherited names such as "toString" from being read
		// as tracked events.
		const status = Object.hasOwn(STATUS_BY_EVENT, event) ? STATUS_BY_EVENT[event] : undefined;
		if (!status) return false;

		const match = matchSubscription(charge.externalReference, charge.subscription);
		if (!match) return false;

		const [subscription] = await this.db
			.select({ id: subscriptionTable.id, userId: subscriptionTable.user_id })
			.from(subscriptionTable)
			.where(match)
			.limit(1);
		if (!subscription) return false;

		const row = toPaymentRow(
			charge,
			{ userId: subscription.userId, subscriptionId: subscription.id },
			status,
		);
		if (!row) return false;

		const insert = this.db.insert(paymentTables).values(row);

		// A new charge never overwrites what later events already stored.
		const [written] =
			status === "PENDING"
				? await insert
						.onConflictDoNothing({ target: paymentTables.asaasPaymentId })
						.returning({ id: paymentTables.id })
				: await insert
						.onConflictDoUpdate({
							target: paymentTables.asaasPaymentId,
							set: {
								status,
								// The card flow sends CONFIRMED and, a month later, RECEIVED.
								...(status === "PAID"
									? { paidAt: sql`coalesce(${paymentTables.paidAt}, now())` }
									: {}),
							},
							setWhere: MOVES_FROM[status],
						})
						.returning({ id: paymentTables.id });

		return Boolean(written);
	}
}
