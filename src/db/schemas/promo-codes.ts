import {
	boolean,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

export const discountTypeEnum = pgEnum("discount_type", ["FIXED", "PERCENTAGE"]);

export const promoCodesTable = pgTable("promo_codes", {
	id: uuid().primaryKey().defaultRandom().notNull(),
	code: varchar().unique().notNull(),
	description: text(),
	discountType: discountTypeEnum("discount_type"),
	durationInCicle: integer("duration_in_cicles").notNull(),
	discountValue: integer("discount_value").notNull(),
	maxRedemptionsGlobal: integer("max_redemptions_global"),
	maxRedemptionsUser: integer("max_redemptions_user"),
	startsAt: timestamp("starts_at").notNull(),
	endsAt: timestamp("ends_at").notNull(),
	isValid: boolean(),
	createdAt: timestamp("created_at").defaultNow(),
});
