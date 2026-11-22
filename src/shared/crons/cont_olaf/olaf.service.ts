import { Injectable, Logger } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { inArray } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { subscriptionTable } from "../../../db/schemas/subscriptions.js";
import { PaymentService } from "../../../payment/payment.service.js";
import { PaymentRecordService } from "../../../subscription/payment-record.service.js";
import { SubscriptionService } from "../../../subscription/subscription.service.js";
import { eventForChargeStatus, PAID_CHARGE_STATUSES } from "./olaf.mapping.js";

/** A PENDING row without an Asaas id younger than this may still be in creation. */
export const ORPHAN_AFTER_MS = 60 * 60 * 1000;
export const NOT_ON_ASAAS_REASON = "OLAF_NOT_ON_ASAAS";

export interface LiveSubscription {
	id: string;
	status: "PENDING" | "ACTIVE" | "EXPIRED" | "INACTIVE" | null;
	asaasSubscriptionId: string | null;
	subscribedAt: Date | null;
}

export interface OlafSummary {
	checked: number;
	activated: number;
	deactivated: number;
	chargesWritten: number;
	failed: number;
}

/**
 * Reconciles local subscriptions and charges with Asaas, for the times a
 * webhook never arrived.
 */
@Injectable()
export class CountOlafService {
	private readonly logger = new Logger(CountOlafService.name);

	constructor(
		@InjectDrizzle() private readonly db: NodePgDatabase,
		private readonly paymentService: PaymentService,
		private readonly subscriptionService: SubscriptionService,
		private readonly paymentRecords: PaymentRecordService,
	) {}

	/** Local subscriptions that are still live: PENDING, ACTIVE or EXPIRED. */
	async findLive(): Promise<LiveSubscription[]> {
		return this.db
			.select({
				id: subscriptionTable.id,
				status: subscriptionTable.status,
				asaasSubscriptionId: subscriptionTable.asaasSubscriptionId,
				subscribedAt: subscriptionTable.subscribedAt,
			})
			.from(subscriptionTable)
			.where(inArray(subscriptionTable.status, ["PENDING", "ACTIVE", "EXPIRED"]));
	}

	/**
	 * Checks every live subscription, one at a time to go easy on the Asaas rate
	 * limit. A failure is logged and skipped; the next run tries it again.
	 */
	async run(now: Date = new Date()): Promise<OlafSummary> {
		const subscriptions = await this.findLive();
		const summary: OlafSummary = {
			checked: subscriptions.length,
			activated: 0,
			deactivated: 0,
			chargesWritten: 0,
			failed: 0,
		};

		for (const subscription of subscriptions) {
			try {
				await this.reconcile(subscription, now, summary);
			} catch (error) {
				summary.failed++;
				this.logger.error(
					`Could not reconcile subscription ${subscription.id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		return summary;
	}

	private async reconcile(
		subscription: LiveSubscription,
		now: Date,
		summary: OlafSummary,
	): Promise<void> {
		const { id, asaasSubscriptionId } = subscription;

		if (!asaasSubscriptionId) {
			const createdAt = subscription.subscribedAt?.getTime();
			const isStaleOrphan =
				subscription.status === "PENDING" &&
				createdAt !== undefined &&
				now.getTime() - createdAt > ORPHAN_AFTER_MS;

			if (isStaleOrphan) await this.end(id, null, NOT_ON_ASAAS_REASON, summary);
			return;
		}

		const remote = await this.paymentService.findSubscription(asaasSubscriptionId);
		if (!remote || remote.deleted) {
			await this.end(id, asaasSubscriptionId, NOT_ON_ASAAS_REASON, summary);
			return;
		}
		if (remote.status !== "ACTIVE") {
			await this.end(id, asaasSubscriptionId, `OLAF_ASAAS_${remote.status}`, summary);
			return;
		}

		// Charges first, so the discount check below counts the backfilled PAID rows.
		const charges = await this.paymentService.listSubscriptionPayments(asaasSubscriptionId);
		let hasPaidCharge = false;
		for (const charge of charges) {
			if (PAID_CHARGE_STATUSES.has(charge.status)) hasPaidCharge = true;

			const event = eventForChargeStatus(charge.status);
			if (!event) continue;

			// Our own ids win over a reference edited on the Asaas panel.
			const written = await this.paymentRecords.recordFromWebhook(event, {
				...charge,
				externalReference: id,
				subscription: asaasSubscriptionId,
			});
			if (written) summary.chargesWritten++;
		}

		if (!hasPaidCharge) return;

		if (subscription.status === "PENDING") {
			const activated = await this.subscriptionService.activateFromPayment(id, asaasSubscriptionId);
			if (activated) {
				summary.activated++;
				this.logger.warn(`Subscription ${id} activated: paid on Asaas but still PENDING`);
			}
		}

		// Also catches a missed renewal webhook that should have ended the promo.
		await this.subscriptionService.endDiscountIfExhausted(id, asaasSubscriptionId);
	}

	private async end(
		id: string,
		asaasSubscriptionId: string | null,
		reason: string,
		summary: OlafSummary,
	): Promise<void> {
		const ended = await this.subscriptionService.deactivate(id, asaasSubscriptionId, reason);
		if (ended) {
			summary.deactivated++;
			this.logger.warn(`Subscription ${id} deactivated: ${reason}`);
		}
	}
}
