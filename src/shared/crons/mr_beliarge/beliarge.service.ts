import { Injectable } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, eq, inArray } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Payment, paymentTables } from "../../../db/schemas/payments.js";
import { Subscription, subscriptionTable } from "../../../db/schemas/subscriptions.js";

type SubscriptionAndPayment = Subscription & {
	payments: Payment[];
};

@Injectable()
export class MrBeliargeService {
	carefreeMax = 3;
	constructor(@InjectDrizzle() private readonly db: NodePgDatabase) {}

	async getUnpaidRents() {
		const rows = await this.db
			.select({
				subscription: subscriptionTable,
				payment: paymentTables,
			})
			.from(subscriptionTable)
			.leftJoin(paymentTables, eq(paymentTables.subscriptionId, subscriptionTable.id))
			.where(inArray(subscriptionTable.status, ["ACTIVE", "EXPIRED"]));

		const subscriptionPaymentsMap = new Map<string, SubscriptionAndPayment>();

		rows.forEach((item) => {
			let has: SubscriptionAndPayment | undefined = subscriptionPaymentsMap.get(
				item.subscription.id,
			);

			if (!has) {
				has = {
					...item.subscription,
					payments: [],
				};

				subscriptionPaymentsMap.set(item.subscription.id, has);
			}

			if (item.payment) {
				has.payments.push(item.payment);
			}
		});

		console.log(subscriptionPaymentsMap);
	}
}
