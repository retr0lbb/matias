import { date, integer, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { subscriptionTable } from "./subscriptions.js";
import { userTable } from "./user.js";

export const billingTypeEnum = pgEnum("billing_type_enum", ["PIX", "BOLETO", "CARTAO_DE_CREDITO"]);
export const paymentStatusEnum = pgEnum("payment_status_enum", [
	"PENDING",
	"PAID",
	"FAILED",
	"OVERDUE",
	"REFUNDED",
]);

// One row per Asaas charge: the first one of a subscription and every renewal.
export const paymentTables = pgTable("payments", {
	id: uuid().primaryKey().defaultRandom().notNull(),
	userId: uuid("user_id").references(() => userTable.id),
	subscriptionId: uuid("subscription_id").references(() => subscriptionTable.id),
	asaasPaymentId: varchar("asaas_payment_id").notNull().unique(), // Asaas charge id (pay_...)
	customerId: varchar().notNull(), // Asaas customer id (cus_...)
	billingType: billingTypeEnum("billing_type").notNull(),
	dueDate: date("due_date"), // due date of this charge, YYYY-MM-DD
	status: paymentStatusEnum("status").default("PENDING"),
	value: integer().notNull(), // in cents, like plans.price
	paidAt: timestamp("paid_at"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PaymentStatus = (typeof paymentStatusEnum.enumValues)[number];
export type BillingType = (typeof billingTypeEnum.enumValues)[number];
