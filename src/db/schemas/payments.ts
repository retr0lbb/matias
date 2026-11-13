import { integer, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { subscriptionTable } from "./subscriptions.js";
import { userTable } from "./user.js";

export const billingTypeEnum = pgEnum("billing_type_enum", ["PIX", "BOLETO", "CARTAO_DE_CREDITO"]);
export const paymentStatusEnum = pgEnum("payment_status_enum", ["PENDING", "PAID", "FAILED"]);

export const paymentTables = pgTable("payments", {
	id: uuid().primaryKey().defaultRandom().notNull(),
	userId: uuid("user_id").references(() => userTable.id),
	subcriptionId: uuid("subscription_id").references(() => subscriptionTable.id),
	customerId: varchar().notNull(), //id per transaction if it is possible
	billingType: billingTypeEnum("billing_type").notNull(),
	nextDueDate: timestamp("next_due_date"),
	status: paymentStatusEnum("status").default("PENDING"),
	value: integer().notNull(),
});
