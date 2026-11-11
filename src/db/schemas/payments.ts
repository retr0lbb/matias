import { pgTable, uuid } from "drizzle-orm/pg-core";
import { subscriptionTable } from "./subscriptions.js";
import { userTable } from "./user.js";

export const paymentTables = pgTable("payments", {
	id: uuid().primaryKey().defaultRandom().notNull(),
	userId: uuid("user_id").references(() => userTable.id),
	subId: uuid("subscription_id").references(() => subscriptionTable.id),
});
