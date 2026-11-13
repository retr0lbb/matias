import { sql } from "drizzle-orm";
import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { planTable } from "./plans.js";
import { userTable } from "./user.js";

export const subscriptionsTableStatus = pgEnum("subscription_status", [
	"PENDING",
	"ACTIVE",
	"EXPIRED",
	"INACTIVE",
]);

export const subscriptionTable = pgTable(
	"subscriptions",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid()
			.references(() => userTable.id)
			.notNull(),
		plan_id: uuid()
			.references(() => planTable.id)
			.notNull(),
		status: subscriptionsTableStatus().default("PENDING"),
		subscribedAt: timestamp("subscribed_at").defaultNow(),
		cancelledAt: timestamp("cancelled_at"),
		cancelReason: text("cancel_reason"),
		customerId: varchar(), // Asaas customer id (cus_...); null until the customer is created
		asaasSubscriptionId: varchar("asaas_subscription_id"), // Asaas subscription id (sub_...); null until it is created
	},
	(table) => [
		uniqueIndex("one_live_subscription_per_user")
			.on(table.user_id)
			.where(sql`${table.status} in ('PENDING', 'ACTIVE', 'EXPIRED')`), //not inactive ones mate these can be recambobulated
	],
);
