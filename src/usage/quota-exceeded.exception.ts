import { HttpException, HttpStatus } from "@nestjs/common";

export type QuotaCode =
  | "UPLOADS_PER_CYCLE"
  | "FILE_TOO_LARGE"
  | "STORAGE"
  | "ADVANCED_MESSAGES"
  | "ASSESSMENTS_PER_CYCLE";

export interface QuotaExceededDetails {
  code: QuotaCode;
  /** Plain-language sentence safe to show to non-technical users. */
  message: string;
  limit: number;
  used: number;
  resetsAt: Date | null;
}

export interface QuotaExceededBody {
  statusCode: number;
  error: "QuotaExceeded";
  code: QuotaCode;
  message: string;
  limit: number;
  used: number;
  resetsAt: string | null;
}

/**
 * Thrown when a user hits a plan limit. `code` is stable so clients can
 * translate the message; `message` is already user-friendly.
 */
export class QuotaExceededException extends HttpException {
  readonly code: QuotaCode;

  constructor(details: QuotaExceededDetails) {
    const status =
      details.code === "FILE_TOO_LARGE"
        ? HttpStatus.PAYLOAD_TOO_LARGE
        : HttpStatus.TOO_MANY_REQUESTS;

    const body: QuotaExceededBody = {
      statusCode: status,
      error: "QuotaExceeded",
      code: details.code,
      message: details.message,
      limit: details.limit,
      used: details.used,
      resetsAt: details.resetsAt ? details.resetsAt.toISOString() : null,
    };

    super(body, status);
    this.code = details.code;
  }
}
