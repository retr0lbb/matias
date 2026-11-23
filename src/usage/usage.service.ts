import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { conversationsTable } from "../db/schemas/conversation.js";
import {
  type DocumentCreditReason,
  documentCreditsTable,
} from "../db/schemas/document.js";
import { messageExpenseEnum, messagesTable } from "../db/schemas/message.js";
import { planTable } from "../db/schemas/plans.js";
import { ragDocumentsTable } from "../db/schemas/rag-document.js";
import { subscriptionTable } from "../db/schemas/subscriptions.js";
import type { User } from "../db/schemas/user.js";
import { type BillingCycle, getCycle } from "./billing-cycle.js";
import {
  FREE_PLAN_SLUG,
  isThinkingLevelAllowed,
  type PlanLimits,
  planLimitsSchema,
  type ThinkingLevelOption,
  type UsageCycleKind,
} from "./plan-limits.js";
import { PlanRestrictionException } from "./plan-restriction.exception.js";
import { type QuotaCode, QuotaExceededException } from "./quota-exceeded.exception.js";

export type MessageExpense = (typeof messageExpenseEnum.enumValues)[number];

/** The user fields quota checks need. */
export type UsageSubject = Pick<User, "id" | "cycleAnchorAt">;

/** The database or an open transaction. */
export type DbExecutor = Pick<NodePgDatabase, "select" | "execute" | "insert">;

export interface ResolvedPlan {
  id: string;
  slug: string;
  name: string;
  limits: PlanLimits;
}

/** Everything a chat turn needs to check and pick a model, loaded once. */
export interface ChatAllowance {
  plan: ResolvedPlan;
  cycle: BillingCycle;
  used: Record<MessageExpense, number>;
}

/** Plan limits and document credits spent this cycle. */
export interface DocumentAllowance {
  plan: ResolvedPlan;
  cycle: BillingCycle;
  used: number;
}

export interface ModelChoice {
  model: MessageExpense;
  /** Set when the preferred model had no quota left and a cheaper one was used. */
  downgradedFrom?: MessageExpense;
  /** Set when the preferred model was below the turn's minimum (documents), or full and only a bigger one was left. */
  upgradedFrom?: MessageExpense;
}

type Counter = { used: number; limit: number | null };

export interface UsageSummary {
  plan: { slug: string; name: string };
  cycle: { kind: UsageCycleKind; start: string; resetsAt: string };
  uploads: Counter;
  storage: { usedBytes: number; limitBytes: number | null };
  maxFileBytes: number;
  messages: { cheap: Counter; normal: Counter; expensive: Counter };
  maxThinkingLevel: ThinkingLevelOption;
  /** AI document generation credits; each covers `aiChangesPerDocument` AI changes. */
  documentGeneration: Counter & { aiChangesPerDocument: number | null };
}

// A subscription still grants its plan while payment is overdue (EXPIRED).
const LIVE_STATUSES: ("ACTIVE" | "EXPIRED")[] = ["ACTIVE", "EXPIRED"];
// Biggest first: AUTO downgrades along this list.
const MODELS_BY_COST: MessageExpense[] = ["EXPENSIVE", "NORMAL", "CHEAP"];
const MODEL_LABEL: Record<MessageExpense, string> = {
  CHEAP: "Default",
  NORMAL: "Expert",
  EXPENSIVE: "Doctor",
};
const THINKING_LABEL: Record<ThinkingLevelOption, string> = {
  DEFAULT: "Default",
  HIGH: "High",
  ULTRA_HIGH: "Ultra High",
};
const MB = 1024 * 1024;

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(@InjectDrizzle() private readonly db: NodePgDatabase) {}

  async getUsage(user: UsageSubject): Promise<UsageSummary> {
    const plan = await this.resolvePlan(this.db, user.id);
    const { limits } = plan;
    const cycle = this.cycleFor(user, limits.cycle);

    const [documents, used, documentCredits] = await Promise.all([
      this.countDocuments(this.db, user.id, cycle),
      this.countMessagesByExpense(user.id, cycle),
      this.countDocumentCredits(this.db, user.id, cycle),
    ]);

    return {
      plan: { slug: plan.slug, name: plan.name },
      cycle: {
        kind: limits.cycle,
        start: cycle.start.toISOString(),
        resetsAt: cycle.resetsAt.toISOString(),
      },
      uploads: { used: documents.uploads, limit: limits.uploadsPerCycle },
      storage: {
        usedBytes: documents.storageBytes,
        limitBytes: limits.storageBytes,
      },
      maxFileBytes: limits.maxFileBytes,
      messages: {
        cheap: { used: used.CHEAP, limit: limits.messagesPerCycle.cheap },
        normal: { used: used.NORMAL, limit: limits.messagesPerCycle.normal },
        expensive: { used: used.EXPENSIVE, limit: limits.messagesPerCycle.expensive },
      },
      maxThinkingLevel: limits.maxThinkingLevel,
      documentGeneration: {
        used: documentCredits,
        limit: limits.documentsPerCycle,
        aiChangesPerDocument: limits.aiChangesPerDocument,
      },
    };
  }

  /**
   * The plan of the user's live subscription (ACTIVE or EXPIRED), or the free
   * plan when there is none. Limits are validated because they are edited by hand.
   */
  async resolvePlan(executor: DbExecutor, userId: string): Promise<ResolvedPlan> {
    const columns = {
      id: planTable.id,
      slug: planTable.slug,
      name: planTable.name,
      limits: planTable.limits,
    };

    const [subscribed] = await executor
      .select(columns)
      .from(subscriptionTable)
      .innerJoin(planTable, eq(subscriptionTable.plan_id, planTable.id))
      .where(
        and(
          eq(subscriptionTable.user_id, userId),
          inArray(subscriptionTable.status, LIVE_STATUSES),
        ),
      )
      .limit(1);

    const [row] = subscribed
      ? [subscribed]
      : await executor.select(columns).from(planTable).where(eq(planTable.slug, FREE_PLAN_SLUG)).limit(1);

    if (!row) {
      this.logger.error(`No plan row with slug "${FREE_PLAN_SLUG}"`);
      throw new InternalServerErrorException("Plan configuration is missing");
    }

    const parsed = planLimitsSchema.safeParse(row.limits);
    if (!parsed.success) {
      this.logger.error(`Invalid limits for plan "${row.slug}"`, parsed.error);
      throw new InternalServerErrorException("Plan configuration is invalid");
    }

    return { id: row.id, slug: row.slug, name: row.name, limits: parsed.data };
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
    const { limits } = await this.resolvePlan(executor, user.id);

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

    const cycle = this.cycleFor(user, limits.cycle);
    const { uploads, storageBytes } = await this.countDocuments(
      executor,
      user.id,
      cycle,
    );

    if (limits.uploadsPerCycle !== null && uploads >= limits.uploadsPerCycle) {
      throw new QuotaExceededException({
        code: "UPLOADS_PER_CYCLE",
        message: `You've used all ${limits.uploadsPerCycle} file uploads for ${cycleWord(limits.cycle)}. Your limit resets on ${formatDay(cycle.resetsAt)}.`,
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

  async getChatAllowance(user: UsageSubject): Promise<ChatAllowance> {
    const plan = await this.resolvePlan(this.db, user.id);
    const cycle = this.cycleFor(user, plan.limits.cycle);
    const used = await this.countMessagesByExpense(user.id, cycle);

    return { plan, cycle, used };
  }

  /** Throws when the user explicitly picked a model with no quota left. */
  assertCanChat(allowance: ChatAllowance, expense: MessageExpense): void {
    if (!this.hasQuota(allowance, expense)) {
      throw this.messageQuotaError(allowance, expense);
    }
  }

  /** Throws when the plan doesn't include the requested thinking level (chat and documents). */
  assertThinkingLevelAllowed(
    allowance: { plan: ResolvedPlan },
    requested: ThinkingLevelOption,
  ): void {
    const allowed = allowance.plan.limits.maxThinkingLevel;

    if (!isThinkingLevelAllowed(requested, allowed)) {
      throw new PlanRestrictionException({
        code: "THINKING_LEVEL_NOT_ALLOWED",
        message: `Your plan includes thinking up to ${THINKING_LABEL[allowed]}. Choose a lower thinking level or upgrade your plan to use ${THINKING_LABEL[requested]}.`,
        requested,
        allowed,
      });
    }
  }

  /**
   * Picks the model a turn runs on. Starts at `preferred` raised to `minimum`,
   * then tries cheaper models down to `minimum`. A document turn passes a
   * minimum above CHEAP: it never falls back to CHEAP and may move to a bigger
   * model instead. Throws when no allowed model has quota left.
   */
  pickAvailableModel(
    allowance: ChatAllowance,
    preferred: MessageExpense,
    minimum: MessageExpense = "CHEAP",
  ): ModelChoice {
    const rank = (expense: MessageExpense) => MODELS_BY_COST.length - MODELS_BY_COST.indexOf(expense);
    const start = rank(preferred) >= rank(minimum) ? preferred : minimum;

    // MODELS_BY_COST is biggest first: from `start` down to `minimum`, then the
    // bigger ones going up. Plain chat (minimum CHEAP) never goes up, as before.
    const downward = MODELS_BY_COST.slice(
      MODELS_BY_COST.indexOf(start),
      MODELS_BY_COST.indexOf(minimum) + 1,
    );
    const upward =
      minimum === "CHEAP" ? [] : MODELS_BY_COST.slice(0, MODELS_BY_COST.indexOf(start)).reverse();
    const model = [...downward, ...upward].find((candidate) => this.hasQuota(allowance, candidate));

    if (!model) {
      throw this.messageQuotaError(allowance, minimum);
    }

    if (model === preferred) return { model };
    return rank(model) > rank(preferred)
      ? { model, upgradedFrom: preferred }
      : { model, downgradedFrom: preferred };
  }

  private messageQuotaError(
    allowance: ChatAllowance,
    expense: MessageExpense,
  ): QuotaExceededException {
    const { limits } = allowance.plan;
    const limit = messageLimit(limits, expense) ?? 0;
    const fallback =
      expense === "CHEAP" ? "" : " You can keep chatting with another model or let Auto choose.";

    return new QuotaExceededException({
      code: QUOTA_CODE[expense],
      message: `You've used all ${limit} ${MODEL_LABEL[expense]} messages for ${cycleWord(limits.cycle)}.${fallback} Your limit resets on ${formatDay(allowance.cycle.resetsAt)}.`,
      limit,
      used: allowance.used[expense],
      resetsAt: allowance.cycle.resetsAt,
    });
  }

  private hasQuota(allowance: ChatAllowance, expense: MessageExpense): boolean {
    const limit = messageLimit(allowance.plan.limits, expense);
    return limit === null || allowance.used[expense] < limit;
  }

  /**
   * Document credits spent this cycle. Pass a transaction to re-check under
   * `lockUser` right before spending.
   */
  async getDocumentAllowance(
    executor: DbExecutor,
    user: UsageSubject,
  ): Promise<DocumentAllowance> {
    const plan = await this.resolvePlan(executor, user.id);
    const cycle = this.cycleFor(user, plan.limits.cycle);
    const used = await this.countDocumentCredits(executor, user.id, cycle);

    return { plan, cycle, used };
  }

  /**
   * Whether the next AI change spends a credit. `aiRevisions` is how many AI
   * changes the document already has: with 7 per credit, the 8th (15th, ...)
   * opens a new block and spends one.
   */
  extraCreditNeeded(allowance: DocumentAllowance, aiRevisions: number): boolean {
    const perCredit = allowance.plan.limits.aiChangesPerDocument;
    return perCredit !== null && aiRevisions > 0 && aiRevisions % perCredit === 0;
  }

  /** Throws when no document credit is left this cycle. */
  assertCanSpendDocumentCredit(
    allowance: DocumentAllowance,
    reason: DocumentCreditReason,
  ): void {
    const { limits } = allowance.plan;
    const limit = limits.documentsPerCycle;

    if (limit === null || allowance.used < limit) {
      return;
    }

    const resets = `Your limit resets on ${formatDay(allowance.cycle.resetsAt)}.`;
    const message =
      limit === 0
        ? "Document generation isn't included in your plan."
        : reason === "GENERATE"
          ? `You've generated all ${limit} documents for ${cycleWord(limits.cycle)}. ${resets}`
          : `This document has used its ${limits.aiChangesPerDocument} included AI changes. More changes use one of your document generations, and you've used all ${limit} for ${cycleWord(limits.cycle)}. ${resets}`;

    throw new QuotaExceededException({
      code: "DOCUMENTS_PER_CYCLE",
      message,
      limit,
      used: allowance.used,
      resetsAt: limit === 0 ? null : allowance.cycle.resetsAt,
    });
  }

  /** Writes the ledger row for a spent credit; call inside the same transaction as the change. */
  async recordDocumentCredit(
    executor: DbExecutor,
    entry: { userId: string; documentId: string; reason: DocumentCreditReason },
  ): Promise<void> {
    await executor.insert(documentCreditsTable).values(entry);
  }

  private cycleFor(user: UsageSubject, kind: UsageCycleKind): BillingCycle {
    return getCycle(kind, user.cycleAnchorAt, new Date());
  }

  private async countDocumentCredits(
    executor: DbExecutor,
    userId: string,
    cycle: BillingCycle,
  ): Promise<number> {
    const [row] = await executor
      .select({ used: sql<number>`count(*)`.mapWith(Number) })
      .from(documentCreditsTable)
      .where(
        and(
          eq(documentCreditsTable.userId, userId),
          gte(documentCreditsTable.createdAt, cycle.start),
        ),
      );

    return row?.used ?? 0;
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

  private async countMessagesByExpense(
    userId: string,
    cycle: BillingCycle,
  ): Promise<Record<MessageExpense, number>> {
    const countOf = (expense: MessageExpense) =>
      sql<number>`count(*) filter (where ${eq(messagesTable.expense, expense)})`.mapWith(Number);

    const [row] = await this.db
      .select({
        CHEAP: countOf("CHEAP"),
        NORMAL: countOf("NORMAL"),
        EXPENSIVE: countOf("EXPENSIVE"),
      })
      .from(messagesTable)
      .innerJoin(
        conversationsTable,
        eq(messagesTable.conversationId, conversationsTable.id),
      )
      .where(
        and(
          eq(conversationsTable.userId, userId),
          eq(messagesTable.role, "IA"),
          gte(messagesTable.createdAt, cycle.start),
        ),
      );

    return {
      CHEAP: row?.CHEAP ?? 0,
      NORMAL: row?.NORMAL ?? 0,
      EXPENSIVE: row?.EXPENSIVE ?? 0,
    };
  }
}

const QUOTA_CODE: Record<MessageExpense, QuotaCode> = {
  CHEAP: "CHEAP_MESSAGES",
  NORMAL: "NORMAL_MESSAGES",
  EXPENSIVE: "EXPENSIVE_MESSAGES",
};

function messageLimit(limits: PlanLimits, expense: MessageExpense): number | null {
  const key = expense.toLowerCase() as keyof PlanLimits["messagesPerCycle"];
  return limits.messagesPerCycle[key];
}

function cycleWord(kind: UsageCycleKind): string {
  return kind === "WEEKLY" ? "this week" : "this month";
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
