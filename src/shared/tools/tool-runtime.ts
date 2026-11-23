import type { FunctionDeclaration } from "@google/genai";

/** What a tool hands back to the model: a JSON object, or `{ error }` it can explain. */
export type ToolResult = Record<string, unknown>;

/**
 * Tools offered to the model for one chat turn. `execute` never throws: a
 * failure comes back as `{ error: "<CODE>" }` so the model can tell the user.
 */
export interface ToolRuntime {
	declarations: FunctionDeclaration[];
	execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/** One tool call, as stored in message metadata: never its arguments or result. */
export interface ToolCallRecord {
	name: string;
	ok: boolean;
	latencyMs: number;
}
