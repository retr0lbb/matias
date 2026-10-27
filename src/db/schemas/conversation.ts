import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { userTable } from "./user.js";

export const conversationsTable = pgTable("conversations", 
    {
        title: varchar(),
        id: uuid().primaryKey().defaultRandom(),
        userId: uuid("user_id").references(() => userTable.id, {onDelete: "cascade"}).notNull(),
        createdAt: timestamp().defaultNow().notNull(),
        updatedAt: timestamp().$onUpdateFn(() => new Date()).defaultNow()
    },
    (tb) => [
        index("user_id_updated_at_index").on(tb.userId, tb.updatedAt)
    ]
)