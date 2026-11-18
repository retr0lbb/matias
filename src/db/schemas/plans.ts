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

export const planTable = pgTable("plans", {
	id: uuid().primaryKey().defaultRandom(),
	name: text().notNull(),
	description: text(),
	price: integer().notNull(),
	currency: text().notNull(),
	billing_interval: varchar().notNull(),
	is_active: boolean().default(false),
	limits: jsonb(),
	createdAt: timestamp().defaultNow().notNull(),
	updatedAt: timestamp()
		.$onUpdateFn(() => new Date())
		.defaultNow(),
});

/* EXEMPLO DO JSONB
    uploadsPerCycle: 20,
    maxFileBytes: 10 * MB,
    storageBytes: 200 * MB,
    advancedMessagesPerCycle: 20
*/
