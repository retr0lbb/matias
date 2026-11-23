import { Injectable, Logger } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, eq, inArray, lt, min } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { paymentTables } from "../../../db/schemas/payments.js";
import { subscriptionTable } from "../../../db/schemas/subscriptions.js";
import { PaymentService } from "../../../payment/payment.service.js";
import { SubscriptionService } from "../../../subscription/subscription.service.js";

/** Days an overdue charge may stay unpaid before the subscription ends. */
export const GRACE_DAYS = 3;
export const BELIARGE_REASON = "BELIARGE_OVERDUE_GRACE_EXPIRED";
const TIME_ZONE = "America/Sao_Paulo";

export interface DelinquentSubscription {
	id: string;
	asaasSubscriptionId: string | null;
	oldestOverdueDueDate: string | null;
}

export interface BeliargeSummary {
	checked: number;
	deactivated: number;
	failed: number;
}

/**
 * The last `due_date` (`YYYY-MM-DD`, in São Paulo time) still inside the grace
 * period: a charge due before it has been overdue for more than GRACE_DAYS.
 */
export function graceCutoff(now: Date): string {
	const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
	const cutoff = new Date(`${today}T00:00:00.000Z`);
	cutoff.setUTCDate(cutoff.getUTCDate() - GRACE_DAYS);
	return cutoff.toISOString().slice(0, 10);
}

/**
 * Ends live subscriptions whose oldest overdue charge is past the grace
 * period: deactivates them on Asaas (not deleted) and then locally.
 */
@Injectable()
export class MrBeliargeService {
	private readonly logger = new Logger(MrBeliargeService.name);

	constructor(
		@InjectDrizzle() private readonly db: NodePgDatabase,
		private readonly paymentService: PaymentService,
		private readonly subscriptionService: SubscriptionService,
	) {}

	/**
	 * Live subscriptions (ACTIVE included, in case the PAYMENT_OVERDUE webhook
	 * was missed) with an OVERDUE charge due before the grace cutoff.
	 */
	async findDelinquent(now: Date): Promise<DelinquentSubscription[]> {
		const oldestOverdue = min(paymentTables.dueDate);

		return this.db
			.select({
				id: subscriptionTable.id,
				asaasSubscriptionId: subscriptionTable.asaasSubscriptionId,
				oldestOverdueDueDate: oldestOverdue,
			})
			.from(subscriptionTable)
			.innerJoin(paymentTables, eq(paymentTables.subscriptionId, subscriptionTable.id))
			.where(
				and(
					inArray(subscriptionTable.status, ["ACTIVE", "EXPIRED"]),
					eq(paymentTables.status, "OVERDUE"),
				),
			)
			.groupBy(subscriptionTable.id)
			.having(lt(oldestOverdue, graceCutoff(now)));
	}

	/**
	 * Deactivates every delinquent subscription. An Asaas failure skips that
	 * subscription without touching it locally, so the next run retries it.
	 */
	async run(now: Date = new Date()): Promise<BeliargeSummary> {
		const delinquent = await this.findDelinquent(now);
		const summary: BeliargeSummary = { checked: delinquent.length, deactivated: 0, failed: 0 };

		for (const subscription of delinquent) {
			try {
				if (subscription.asaasSubscriptionId) {
					await this.paymentService.deactivateSubscription(subscription.asaasSubscriptionId);
				}

				const ended = await this.subscriptionService.deactivate(
					subscription.id,
					subscription.asaasSubscriptionId,
					BELIARGE_REASON,
				);
				if (ended) {
					summary.deactivated++;
					this.logger.warn(
						`Subscription ${subscription.id} deactivated: overdue since ${subscription.oldestOverdueDueDate}`,
					);
				}
			} catch (error) {
				summary.failed++;
				this.logger.error(
					`Could not deactivate subscription ${subscription.id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		return summary;
	}
}
