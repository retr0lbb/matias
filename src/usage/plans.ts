import type { Plan } from "../db/schemas/user.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** `null` means unlimited. */
export interface PlanLimits {
  uploadsPerCycle: number | null;
  maxFileBytes: number;
  storageBytes: number | null;
  advancedMessagesPerCycle: number | null;
  /** AI-generated assessments (documents module). */
  assessmentsPerCycle: number | null;
  /**
   * AI changes covered by each assessment credit. Every further block of this
   * size on the same assessment uses one more credit from `assessmentsPerCycle`.
   */
  aiRevisionsPerAssessmentCredit: number | null;
}

// Single source of truth for every plan's caps.
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: {
    uploadsPerCycle: 20,
    maxFileBytes: 10 * MB,
    storageBytes: 200 * MB,
    advancedMessagesPerCycle: 20,
    assessmentsPerCycle: 30,
    aiRevisionsPerAssessmentCredit: 7,
  },
  PRO: {
    uploadsPerCycle: 100,
    maxFileBytes: 20 * MB,
    storageBytes: 2 * GB,
    advancedMessagesPerCycle: 300,
    assessmentsPerCycle: 30,
    aiRevisionsPerAssessmentCredit: 7,
  },
};

/** Largest file any plan accepts; used as the static multer limit. */
export const MAX_FILE_BYTES_ANY_PLAN = Math.max(
  ...Object.values(PLAN_LIMITS).map((limits) => limits.maxFileBytes),
);
