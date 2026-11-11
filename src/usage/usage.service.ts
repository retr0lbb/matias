import { Injectable } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, count, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { conversationsTable } from "../db/schemas/conversation.js";
import { messageExpenseEnum, messagesTable } from "../db/schemas/message.js";
import { assessmentsTable } from "../db/schemas/assessment.js";
import { ragDocumentsTable } from "../db/schemas/rag-document.js";
import type { Plan, User } from "../db/schemas/user.js";
import { getCurrentCycle, type BillingCycle } from "./billing-cycle.js";
import { PLAN_LIMITS } from "./plans.js";
import { QuotaExceededException } from "./quota-exceeded.exception.js";

export type MessageExpense = (typeof messageExpenseEnum.enumValues)[number];

/** The user fields quota checks need. */
export type UsageSubject = Pick<User, "id" | "plan" | "cycleAnchorAt">;

/** The database or an open transaction. */
export type DbExecutor = Pick<NodePgDatabase, "select" | "execute">;

const ADVANCED_EXPENSES: MessageExpense[] = ["NORMAL", "EXPENSIVE"];
const MB = 1024 * 1024;

export interface UsageSummary {
  plan: Plan;
  cycle: { start: string; resetsAt: string };
  uploads: { used: number; limit: number | null };
  storage: { usedBytes: number; limitBytes: number | null };
  maxFileBytes: number;
  advancedMessages: { used: number; limit: number | null };
  assessments: { used: number; limit: number | null };
}

@Injectable()
export class UsageService {
  constructor(@InjectDrizzle() private readonly db: NodePgDatabase) {}

  async getUsage(user: UsageSubject): Promise<UsageSummary> {
    const limits = PLAN_LIMITS[user.plan];
    const cycle = this.cycleFor(user);

    const [documents, advancedMessages, assessments] = await Promise.all([
      this.countDocuments(this.db, user.id, cycle),
      this.countAdvancedMessages(user.id, cycle),
      this.countAssessments(this.db, user.id, cycle),
    ]);

    return {
      plan: user.plan,
      cycle: {
        start: cycle.start.toISOString(),
        resetsAt: cycle.resetsAt.toISOString(),
      },
      uploads: { used: documents.uploads, limit: limits.uploadsPerCycle },
      storage: {
        usedBytes: documents.storageBytes,
        limitBytes: limits.storageBytes,
      },
      maxFileBytes: limits.maxFileBytes,
      advancedMessages: {
        used: advancedMessages,
        limit: limits.advancedMessagesPerCycle,
      },
      assessments: { used: assessments, limit: limits.assessmentsPerCycle },
    };
  }

  /**
   * Serializes quota checks for one user until the transaction ends, so
   * concurrent uploads cannot both pass the last free slot.
   */
  async lockUser(executor: DbExecutor, userId: string): Promise<void> {
    await executor.execute(
      sql`select pg_advisory_xact_lock(hashtext(${userId}))`,
    );
  }

  async assertCanUpload(
    executor: DbExecutor,
    user: UsageSubject,
    sizeBytes: number,
  ): Promise<void> {
    const limits = PLAN_LIMITS[user.plan];

    if (sizeBytes > limits.maxFileBytes) {
      throw new QuotaExceededException({
        code: "FILE_TOO_LARGE",
        message: `This file is too large. Your plan accepts files up to ${formatMb(limits.maxFileBytes)} MB.`,
        limit: limits.maxFileBytes,
        used: sizeBytes,
        resetsAt: null,
      });
    }

    if (limits.uploadsPerCycle === null && limits.storageBytes === null) {
      return;
    }

    const cycle = this.cycleFor(user);
    const { uploads, storageBytes } = await this.countDocuments(
      executor,
      user.id,
      cycle,
    );

    if (limits.uploadsPerCycle !== null && uploads >= limits.uploadsPerCycle) {
      throw new QuotaExceededException({
        code: "UPLOADS_PER_CYCLE",
        message: `You've used all ${limits.uploadsPerCycle} file uploads for this month. Your limit resets on ${formatDay(cycle.resetsAt)}.`,
        limit: limits.uploadsPerCycle,
        used: uploads,
        resetsAt: cycle.resetsAt,
      });
    }

    if (
      limits.storageBytes !== null &&
      storageBytes + sizeBytes > limits.storageBytes
    ) {
      throw new QuotaExceededException({
        code: "STORAGE",
        message: `You don't have enough storage space left for this file. Your plan includes ${formatMb(limits.storageBytes)} MB.`,
        limit: limits.storageBytes,
        used: storageBytes,
        resetsAt: null,
      });
    }
  }

  async assertCanChat(
    user: UsageSubject,
    expense: MessageExpense,
  ): Promise<void> {
    if (!ADVANCED_EXPENSES.includes(expense)) {
      return;
    }

    const limit = PLAN_LIMITS[user.plan].advancedMessagesPerCycle;
    if (limit === null) {
      return;
    }

    const cycle = this.cycleFor(user);
    const used = await this.countAdvancedMessages(user.id, cycle);

    if (used >= limit) {
      throw new QuotaExceededException({
        code: "ADVANCED_MESSAGES",
        message: `You've used all ${limit} advanced AI messages for this month. You can keep chatting with the standard model, and your limit resets on ${formatDay(cycle.resetsAt)}.`,
        limit,
        used,
        resetsAt: cycle.resetsAt,
      });
    }
  }

  async assertCanCreateAssessment(
    executor: DbExecutor,
    user: UsageSubject,
  ): Promise<void> {
    const limit = PLAN_LIMITS[user.plan].assessmentsPerCycle;
    if (limit === null) {
      return;
    }

    const cycle = this.cycleFor(user);
    const used = await this.countAssessments(executor, user.id, cycle);

    if (used >= limit) {
      throw new QuotaExceededException({
        code: "ASSESSMENTS_PER_CYCLE",
        message: `You've created all ${limit} assessments for this month. Your limit resets on ${formatDay(cycle.resetsAt)}.`,
        limit,
        used,
        resetsAt: cycle.resetsAt,
      });
    }
  }

  private cycleFor(user: UsageSubject): BillingCycle {
    return getCurrentCycle(user.cycleAnchorAt, new Date());
  }

  // FAILED documents were never usable, so they don't count against the user.
  private async countDocuments(
    executor: DbExecutor,
    userId: string,
    cycle: BillingCycle,
  ): Promise<{ uploads: number; storageBytes: number }> {
    const [row] = await executor
      .select({
        uploads: sql<number>`count(*) filter (where ${gte(ragDocumentsTable.createdAt, cycle.start)})`.mapWith(Number),
        storageBytes: sql<number>`coalesce(sum(${ragDocumentsTable.sizeBytes}), 0)`.mapWith(Number),
      })
      .from(ragDocumentsTable)
      .where(
        and(
          eq(ragDocumentsTable.userId, userId),
          ne(ragDocumentsTable.status, "FAILED"),
        ),
      );

    return {
      uploads: row?.uploads ?? 0,
      storageBytes: row?.storageBytes ?? 0,
    };
  }

  private async countAssessments(
    executor: DbExecutor,
    userId: string,
    cycle: BillingCycle,
  ): Promise<number> {
    const [row] = await executor
      .select({ used: count() })
      .from(assessmentsTable)
      .where(
        and(
          eq(assessmentsTable.userId, userId),
          gte(assessmentsTable.createdAt, cycle.start),
        ),
      );

    return row?.used ?? 0;
  }

  private async countAdvancedMessages(
    userId: string,
    cycle: BillingCycle,
  ): Promise<number> {
    const [row] = await this.db
      .select({ used: count() })
      .from(messagesTable)
      .innerJoin(
        conversationsTable,
        eq(messagesTable.conversationId, conversationsTable.id),
      )
      .where(
        and(
          eq(conversationsTable.userId, userId),
          eq(messagesTable.role, "IA"),
          inArray(messagesTable.expense, ADVANCED_EXPENSES),
          gte(messagesTable.createdAt, cycle.start),
        ),
      );

    return row?.used ?? 0;
  }
}

function formatMb(bytes: number): number {
  return Math.round(bytes / MB);
}

function formatDay(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
