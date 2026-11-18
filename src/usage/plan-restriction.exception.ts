import { HttpException, HttpStatus } from "@nestjs/common";
import type { ThinkingLevelOption } from "./plan-limits.js";

export interface PlanRestrictionBody {
  statusCode: number;
  error: "PlanRestriction";
  code: "THINKING_LEVEL_NOT_ALLOWED";
  /** Plain-language sentence safe to show to non-technical users. */
  message: string;
  requested: ThinkingLevelOption;
  allowed: ThinkingLevelOption;
}

/**
 * Thrown when the user asks for something their plan doesn't include (not a
 * per-cycle quota, so it is a 403, not a 429). `code` is stable for clients.
 */
export class PlanRestrictionException extends HttpException {
  constructor(details: Omit<PlanRestrictionBody, "statusCode" | "error">) {
    const body: PlanRestrictionBody = {
      statusCode: HttpStatus.FORBIDDEN,
      error: "PlanRestriction",
      ...details,
    };

    super(body, HttpStatus.FORBIDDEN);
  }
}
