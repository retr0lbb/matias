import {
	boolean,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import type { PlanLimits } from "../../usage/plan-limits.js";

export const planTable = pgTable("plans", {
	id: uuid().primaryKey().defaultRandom(),
	/** Stable identifier used in code ("free", "pro"); the display name can change. */
	slug: varchar().notNull().unique(),
	name: text().notNull(),
	description: text(),
	price: integer().notNull(),
	currency: text().notNull(),
	billing_interval: varchar().notNull(),
	/** Whether the plan can be bought. The free plan is false. */
	is_active: boolean().default(false),
	/** Validated with `planLimitsSchema` (src/usage/plan-limits.ts) on read. */
	limits: jsonb().$type<PlanLimits>(),
	createdAt: timestamp().defaultNow().notNull(),
	updatedAt: timestamp()
		.$onUpdateFn(() => new Date())
		.defaultNow(),
});
