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
// Mirrors AIExpense (src/ai/ai.factory.ts); used to count advanced-model usage.
export const messageExpenseEnum = pgEnum("message_expense", ["CHEAP", "NORMAL", "EXPENSIVE"])

export type MessageTokenUsage = {
    prompt: number,
    /** Answer tokens only (Gemini candidatesTokenCount). */
    output: number,
    thoughts: number,
    cached: number,
    total: number
}

export type JudgeMetadata = {
    modelId: string,
    latencyMs: number,
    tokens: MessageTokenUsage
}

/**
 * Stored on IA messages. Generation fields are missing when the stream was
 * aborted or failed before the model finished.
 */
export type MessageMetadata = {
    tier: "CHEAP" | "NORMAL" | "EXPENSIVE",
    /** AUTO = judge picked the tier; MANUAL = user picked it. */
    selection?: "AUTO" | "MANUAL",
    /** Tier the judge wanted before AUTO downgraded it for lack of quota. */
    downgradedFrom?: "CHEAP" | "NORMAL" | "EXPENSIVE",
    /** Tier picked (judge or user) before a document turn raised it to what the document needs. */
    upgradedFrom?: "CHEAP" | "NORMAL" | "EXPENSIVE",
    /** User-facing thinking level the turn ran with (already allowed by the plan). */
    thinkingOption?: "DEFAULT" | "HIGH" | "ULTRA_HIGH",
    /** Model requested by the app. */
    modelName?: string,
    /** Model version Gemini reports it actually used. */
    modelId?: string,
    /** Gemini thinking level actually sent. */
    thinkingLevel?: string,
    finishReason?: string,
    latencyMs?: number,
    tokens?: MessageTokenUsage,
    thinking?: string,
    judge?: JudgeMetadata,
    /** Tools called this turn: name, outcome and latency only (no arguments or results). */
    tools?: { name: string, ok: boolean, latencyMs: number }[],
    /** Document work of this turn. ASK_HEADER marks the turn that asked for header details. */
    document?: DocumentTurnMetadata
}

export type DocumentTurnMetadata =
    | { action: "ASK_HEADER", type: string, missing: string[] }
    | {
        action: "CREATE" | "REVISE" | "REGENERATE",
        type: string,
        ok: boolean,
        /** The saved document; missing when it failed or the AI asked a question instead. */
        id?: string,
        /** The AI asked the teacher what the document should be about; nothing was saved. */
        clarification?: boolean,
        /** Document AI usage, summed over its attempts. */
        modelName?: string,
        modelId?: string,
        latencyMs?: number,
        attempts?: number,
        tokens?: MessageTokenUsage
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
        status: messageStatusEnum(),
        expense: messageExpenseEnum()
    },
    (tb) => [
        index("conversationid_created_at_index").on(tb.conversationId, tb.createdAt)
    ]
)