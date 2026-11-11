import { integer, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { discountTypeEnum, promoCodesTable } from "./promo-codes.js";
import { subscriptionTable } from "./subscriptions.js";
import { userTable } from "./user.js";

export const promoCodeRedemptionEnum = pgEnum("promo_code_redemption_status_enum", [
	"PENDING",
	"APPLIED",
	"REVOKED",
]);

export const promoCodeRedemptions = pgTable("promo_code_redemption", {
	id: uuid().primaryKey().defaultRandom(),
	promoCodeId: uuid("promo_code_id")
		.references(() => promoCodesTable.id)
		.notNull(),
	userId: uuid("user_id")
		.references(() => userTable.id)
		.notNull(),

	subscriptionId: uuid("subscription_id").references(() => subscriptionTable.id),
	status: promoCodeRedemptionEnum().default("PENDING"),
	discountType: discountTypeEnum("discount_type"),
	durationInCicle: integer("duration_in_cicles").notNull(),
	discountValue: integer("discount_value").notNull(),
	redeemedAt: timestamp("redeemed_at"),
	createdAt: timestamp("created_at").defaultNow(),
});
