# Plan limits from DB + model / thinking-level selection

> **Update (2026-11-22):** `POST /ai/chat`, `AiService.chat()` and every model's `generate()` were removed. `POST /ai/chat/stream` is now the only chat route, and models only implement `generateStream()`. Passages below about the non-streaming path are history.

## Context

Limits are hard-coded in `PLAN_LIMITS` (`src/usage/plans.ts`) and picked by `users.plan` (FREE/PRO enum).
`plans.limits` (jsonb) exists but is untyped and never read. NORMAL and EXPENSIVE share one counter
(`advancedMessagesPerCycle`), the judge always picks the model, and thinking levels are constants
per model class.

Goal: limits live in `plans.limits` and are resolved via the user's live subscription (or the Free
plan row); separate per-model message limits; a per-plan max thinking level; the user chooses
`AUTO | CHEAP | NORMAL | EXPENSIVE` and a thinking level.

Decisions (from Q&A):
- Free users → a `free` row in `plans` (price 0, `is_active = false` so it can't be bought).
- Plans found by a new unique `plans.slug` (`free`, `pro`).
- `users.plan` + `plan_enum` are **removed**.
- Thinking: user picks `DEFAULT | HIGH | ULTRA_HIGH` (default `DEFAULT`). Above the plan `maxThinkingLevel` → 403 `THINKING_LEVEL_NOT_ALLOWED` before generation (changed from silent clamping after testing; skipped for explicit CHEAP, which always uses MINIMAL).
  Mapping to Gemini: `DEFAULT → LOW`, `HIGH → MEDIUM`, `ULTRA_HIGH → HIGH`. CHEAP always stays MINIMAL.
- Model tiers keep backend names `CHEAP | NORMAL | EXPENSIVE`; the frontend labels them
  **Default / Expert / Doctor**. No backend rename.
- AUTO: the judge decides the tier. Explicit model over quota → 429. AUTO over quota → downgrade EXPENSIVE → NORMAL → CHEAP.
- Free plan limits reset **weekly**; Pro stays **monthly** (`cycle` field in the limits JSON).
- CHEAP limit optional (`null` = unlimited).

Step 0 (per memory): copy this plan to `specs/plan-limits-model-selection.md`, and save a project
memory with the tier labels (Default/Expert/Doctor) and the thinking-level mapping.

## 1. Limits JSON & schema

New `src/usage/plan-limits.ts` (replaces `src/usage/plans.ts`):

```ts
export const THINKING_LEVELS = ["DEFAULT", "HIGH", "ULTRA_HIGH"] as const; // ordered low → high
export const planLimitsSchema = z.object({
  cycle: z.enum(["WEEKLY", "MONTHLY"]),
  uploadsPerCycle: z.number().int().nonnegative().nullable(),
  maxFileBytes: z.number().int().positive(),
  storageBytes: z.number().int().nonnegative().nullable(),
  messagesPerCycle: z.object({
    cheap: z.number().int().nonnegative().nullable(),
    normal: z.number().int().nonnegative().nullable(),
    expensive: z.number().int().nonnegative().nullable(),
  }),
  maxThinkingLevel: z.enum(THINKING_LEVELS),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;
/** Static multer ceiling; per-plan maxFileBytes is still enforced by UsageService. */
export const MAX_UPLOAD_BYTES = 50 * MB;
```

- Limits are edited by hand in the DB, so they are **zod-parsed on read**. Invalid JSON → `InternalServerErrorException` + log (fail closed).
- `src/db/schemas/plans.ts`: `limits: jsonb().$type<PlanLimits>()`, add `slug: varchar().notNull().unique()`, remove the example comment.
- `src/db/schemas/user.ts`: drop `plan` column, `planEnum`, `Plan` type.
- `src/rag/rag-documents.controller.ts`: `MAX_FILE_BYTES_ANY_PLAN` → `MAX_UPLOAD_BYTES`.

**Migration** (`npm run db:generate`, then hand-edit the SQL):
1. add `slug` nullable → `UPDATE plans SET slug = lower(name)` → set NOT NULL + unique;
2. insert the `free` plan row (if no `free` slug exists);
3. `UPDATE plans SET limits = ...` for `pro`;
4. drop `users.plan`, drop type `plan_enum`.

Proposed values (easy to change later in the DB):

| | Free | Pro |
|---|---|---|
| cycle | WEEKLY | MONTHLY |
| uploadsPerCycle / maxFileBytes / storageBytes | 5 / 10 MB / 200 MB | 100 / 20 MB / 2 GB |
| messagesPerCycle cheap / normal / expensive | null / 5 / 2 | null / 300 / 100 |
| maxThinkingLevel | HIGH | ULTRA_HIGH |

(storageBytes is a total, not per cycle.)

## 2. Usage module (`src/usage/usage.service.ts`)

- `resolvePlan(executor, userId): Promise<{ id, slug, name, limits }>`:
  live subscription (`status in ('ACTIVE','EXPIRED')`; EXPIRED = past due, still live) joined to `plans`;
  else the `free` slug row. PENDING does not grant the plan.
- Cycle per plan: `src/usage/billing-cycle.ts` gains `getCurrentWeeklyCycle(anchor, now)`
  (7-day windows from the anchor's UTC midnight) and `getCycle(kind, anchor, now)` that dispatches
  to it or the existing monthly `getCurrentCycle`. `cycleFor(user)` → `cycleFor(user, limits.cycle)`.
  Quota messages say "this week" / "this month" accordingly.
- `UsageSubject` becomes `Pick<User, "id" | "cycleAnchorAt">`; every check calls `resolvePlan` first.
- `countMessagesByExpense(userId, cycle)` → `{ CHEAP, NORMAL, EXPENSIVE }` in one query
  (`count(*) filter (where expense = …)`) and replaces `countAdvancedMessages`. Counting rules stay the same (IA role, cycle start).
- `getChatAllowance(user)` → `{ limits, used, cycle }`; used once per turn by the AI layer.
- `assertCanChat(allowance, expense)` → throws `CHEAP_MESSAGES | NORMAL_MESSAGES | EXPENSIVE_MESSAGES`.
- `pickAvailableModel(allowance, preferred)` → first of preferred/lower tiers with quota left; if none (even CHEAP), throws the CHEAP code.
- `clampThinkingLevel(requested, max)`.
- `assertCanUpload` keeps its logic, now reading `resolvePlan(...).limits` (inside the existing locked tx).
- `QuotaCode` (`quota-exceeded.exception.ts`): drop `ADVANCED_MESSAGES`, add the three per-model codes.
- `UsageSummary` (**API change for the frontend**):
  `plan: { slug, name }`, `messages: { cheap, normal, expensive: { used, limit } }`, `maxThinkingLevel`; uploads/storage unchanged.

## 3. Subscription service (because `users.plan` is removed)

`src/subscription/subscription.service.ts`:
- activation: remove the `planEnum` name matching, keep `cycleAnchorAt: new Date()` update;
- cancel: drop `.set({ plan: "FREE" })` (the subscription going INACTIVE is enough).

Update only the directly affected assertions/fixtures in `subscription.service.spec.ts` and
`subscription.controller.spec.ts` (`plan: "FREE"` fixtures, `{ plan: "PRO", cycleAnchorAt }` expectation,
name-matching activation cases). No other spec changes.

## 4. Model & thinking selection (AI layer)

- `src/ai/ai.controller.ts` body schema (both endpoints):
  `model: z.enum(["AUTO","CHEAP","NORMAL","EXPENSIVE"]).default("AUTO")`,
  `thinkingLevel: z.enum(THINKING_LEVELS).default("DEFAULT")`.
- `AiProvider` input gets `thinkingLevel: ThinkingLevel`. NORMAL/EXPENSIVE use it for both
  `generate` and `generateStream` (remove their `THINKING_LEVEL`/`STREAM_THINKING_LEVEL` constants);
  CHEAP ignores it (MINIMAL). One helper `toGeminiThinkingLevel()` in `src/ai/models/gemini-response.ts`:
  `DEFAULT → LOW`, `HIGH → MEDIUM`, `ULTRA_HIGH → HIGH`.
- `AiService` flow (shared by `chat()` and the stream):
  1. `allowance = usageService.getChatAllowance(user)`.
  2. Explicit model → `assertCanChat` **in `prepareStream`** (before SSE headers → a real HTTP 429).
  3. Judge runs (it still decides `retrieve` + `title`). AUTO → `pickAvailableModel(allowance, judge.model)`.
  4. `thinkingLevel = clampThinkingLevel(requested, limits.maxThinkingLevel)`.
- SSE `status: generating` gains `thinkingLevel`, `selection: "AUTO" | "MANUAL"`, `downgradedFrom?`
  (`src/ai/dto/chat-stream-event.ts`).
- `MessageMetadata` (`src/db/schemas/message.ts`) gains `selection`, `requestedThinkingLevel`, `downgradedFrom?`
  (`thinkingLevel` is already stored).

## 5. Judge refactor (`src/ai/models/judge-model.ts`)

- `classify({ prompt, history, routeModel })`: when `routeModel` is false (user picked a model), the
  response schema and prompt omit `model` (fewer tokens, no wasted routing). `JudgeReponse.model` becomes optional.
- Move the prompt text to `src/ai/constants/prompts.ts` (`buildJudgePrompt`).
- Replace the `console.log` timing/key dumps with `Logger.debug` (stop logging part of the API key).
- Keep returning `usage` (`JudgeMetadata`) as added in the last change.

## Critical files

`src/usage/{plan-limits.ts (new), usage.service.ts, quota-exceeded.exception.ts, usage.controller.ts}`,
`src/db/schemas/{plans.ts, user.ts, message.ts}`, `src/subscription/subscription.service.ts` (+2 specs),
`src/ai/{ai.controller.ts, ai.service.ts, ai-provider.type.ts, dto/chat-stream-event.ts, dto/judge-response.dto.ts}`,
`src/ai/models/{judge-model.ts, normal.model.ts, expensive.model.ts, cheap.model.ts}`,
`src/rag/rag-documents.controller.ts`, new `drizzle/<ts>_*/migration.sql`.

Reuse: `getCurrentCycle` (`src/usage/billing-cycle.ts`), `lockUser`, `QuotaExceededException`,
`ZodValidationPipe`, `toTokenUsage` (`src/ai/models/gemini-response.ts`).

## Verification

- `npx tsc --noEmit` (ignore the existing auth spec errors), `npm run lint`.
- `npx vitest run src/subscription` (specs touched by the `users.plan` removal). Skip the full `npm test` while the auth specs are broken (memory).
- Review the generated migration SQL; **ask before running `npm run db:migrate`**.
- Manual, after migrating a dev DB:
  - `GET /usage` as Free and as Pro users (new shape, limits from DB);
  - `POST /ai/chat/stream` with `model: "EXPENSIVE"` over quota → HTTP 429 before the stream;
  - `model: "AUTO"` with EXPENSIVE exhausted → `status` event shows `downgradedFrom: "EXPENSIVE"`;
  - Free + `thinkingLevel: "ULTRA_HIGH"` → clamped to `HIGH`, stored `metadata.thinkingLevel` = Gemini `MEDIUM`;
  - Free user `GET /usage` → `cycle.resetsAt` 7 days after `cycle.start`;
  - upload over the plan's `maxFileBytes` → 413.
- No new spec files unless you ask (AGENTS.md scope rule); I can add `usage.service.spec.ts` afterwards.
