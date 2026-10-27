import { 
    index,
    integer, 
    jsonb, 
    pgEnum, 
    pgTable, 
    text, 
    timestamp, 
    uuid, 
    varchar
} from "drizzle-orm/pg-core";
import { conversationsTable } from "./conversation.js";

export const roleEnum = pgEnum("roles", ["USER", "IA"])
export const messageStatusEnum = pgEnum("message_status", ["FAILED", "COMPLETED", "ERROR"])

export type MessageMetadata = {
    modelName: string,
    temperature: number,
    modelId: string
}

export const messagesTable = pgTable("messages", 
    {
        id: uuid().primaryKey().defaultRandom(),
        conversationId: uuid().references(() => conversationsTable.id, {onDelete: "cascade"}).notNull(),
        role: roleEnum().notNull(),
        content: text(),
        createdAt: timestamp().defaultNow().notNull(),
        metadata: jsonb("metadata").$type<MessageMetadata>(),
        inputTokens: integer("input_tokens").notNull().default(0),
        outputTokens: integer("output_tokens").notNull().default(0),
        interactionId: varchar("interaction_id"),
        status: messageStatusEnum()
    },
    (tb) => [
        index("conversationid_created_at_index").on(tb.conversationId, tb.createdAt)
    ]
)