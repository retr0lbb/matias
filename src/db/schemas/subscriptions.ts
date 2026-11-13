import { pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { planTable } from "./plans.js";
import { userTable } from "./user.js";

export const subscriptionsTableStatus = pgEnum("subscription_status", [
	"PENDING",
	"ACTIVE",
	"EXPIRED",
	"INACTIVE",
]);

export const subscriptionTable = pgTable("subscriptions", {
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
	customerId: varchar(), //returned id from asaas Needs to be null to create fist than update method
});
