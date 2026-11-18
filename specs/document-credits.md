# Document credits after merging `main` into `feat/document-generation`

The document branch was 17 commits behind `main`. Its quota code used the old
`PLAN_LIMITS` / `users.plan`, which `main` replaced with `plans.limits` + subscriptions
(see `plan-limits-model-selection.md`).

## Merge fixes

- `usage.service.ts`: syntax error from the manual merge; document quota functions lost.
- `quota-exceeded.exception.ts`: document quota code lost.
- `package.json`: merge dropped `playwright` (used by `PdfRendererService`) → restored.
- `src/usage/plans.ts`: deleted on `main`, modified on the branch → stays deleted.
- Migrations branched at `ae0679b9` (assessments on one side, payments/plans on the other).
  They touch different tables; the next generated migration joins both leaves.

## Limits (in `plans.limits`)

```jsonc
"documentsPerCycle": 30,      // null = unlimited, 0 = feature off
"aiChangesPerDocument": 7     // AI changes (revise/regenerate) included per credit; null = unlimited
```

| | Free (weekly) | Pro (monthly) |
|---|---|---|
| documentsPerCycle | 3 | 30 |
| aiChangesPerDocument | 7 | 7 |

Rule: generating a document spends 1 credit and includes 7 AI changes. The 8th change spends
1 more credit and covers changes 8–14, and so on. Manual patches are free.

## Credit ledger (replaces counting from `assessments`)

New table `document_credits` (`id`, `user_id`, `document_id` nullable / set null on delete,
`reason` = `GENERATE | EXTRA_CHANGES`, `created_at`). A row is written, under the per-user lock and in
the same transaction as the document write, every time a credit is spent. Usage = rows in the current
cycle. This fixes the old loophole: changes to documents created in earlier cycles were never charged.
(The column was `assessment_id` and the table `assessments` until migration
`20261118182314_document_types`; see `document-blocks.md`.) Every document type spends credits the same way.

`UsageService`: `getDocumentAllowance`, `assertCanSpendDocumentCredit`, `extraCreditNeeded`,
`recordDocumentCredit`. `GET /usage` gains `documentGeneration: { used, limit, aiChangesPerDocument }`.
Quota code: `DOCUMENTS_PER_CYCLE`.

## Thinking level

`POST /documents`, `/documents/:id/revise`, `/documents/:id/regenerate` accept `thinkingLevel` (`DEFAULT | HIGH | ULTRA_HIGH`,
default `DEFAULT` = Gemini LOW, same as before). Above the plan max → 403 `THINKING_LEVEL_NOT_ALLOWED`
(same rule as chat).

## Prompts

Document prompts get the MATIAS identity/tone and the document-generation rules from
`src/ai/constants/prompts.ts` (answer keys with reasoning, ENEM/ITA/FUVEST-style questions cited only
when certain). Shared constants are exported from there so chat and documents stay in sync.

## Multiple-choice justification

`multiple_choice` questions have an optional `explanation` (max 1000 chars): why the correct alternative
is right. The AI is told to always write it (and to rewrite it when a change touches the alternatives);
it is optional in the schema so manual patches and documents saved before it stay valid. It is rendered
only in the answer key ("Justificativa:"), never in the student's test.
