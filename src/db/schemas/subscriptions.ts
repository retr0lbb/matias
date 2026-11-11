import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { planTable } from "./plans.js";
import { userTable } from "./user.js";

const subscriptionsTableStatus = pgEnum("subscription_status", [
	"PENDING",
	"ACTIVE",
	"EXPIRED",
	"INACTIVE",
]);

export const subscriptionTable = pgTable("subscriptions", {
	id: uuid().primaryKey().defaultRandom(),
	user_id: uuid().references(() => userTable.id),
	plan_id: uuid().references(() => planTable.id),
	status: subscriptionsTableStatus().default("PENDING"),
	subscribedAt: timestamp("subscribed_at").defaultNow(),
	cancelledAt: timestamp("cancelled_at"),
	cancelReason: text("cancel_reason"),
});
