# Plan: generate documents from the chat stream

> **Merged with `document-blocks.md` (2026-11-23).** The chat flow below now drives the generic
> documents (5 types, 9 block kinds, table `documents`, routes `/documents/:id`). Names such as
> `AssessmentsService`, `AssessmentAiService` and `/documents/assessments` became `DocumentsService`,
> `DocumentAiService` and `/documents`. See [`merge-documents-into-chat.md`](merge-documents-into-chat.md).

Status: **Phases 0–5 implemented** (2026-11-22). They have not run against real Gemini yet. Phase 6 is optional and Phase 7 is for later. See [Implementation notes](#implementation-notes-2026-11-22).

## Context

Today a teacher has two separate ways to talk to the AI:

| | Chat | Documents |
| --- | --- | --- |
| Route | `POST /ai/chat/stream` (SSE) | `POST /documents/assessments`, `/:id/revise`, `/:id/regenerate` (plain JSON) |
| Model | Judge (`gemini-3.1-flash-lite`) picks CHEAP / NORMAL / EXPENSIVE | Always `gemini-3.5-flash`, hard-coded in `src/documents/ai/document-ai.service.ts` |
| Gemini client | `AiExpensesFactory` → `CheapModel` / `NormalModel` / `ExpensiveModel` | A separate `GoogleGenAI` client inside `AssessmentAiService` |
| Context the AI sees | History (20 messages), RAG chunks of the conversation, Classroom tools | Only the teacher's prompt (no history, no uploaded files) |
| Usage records | Tokens and judge usage stored in `messages.metadata` | Document credits only; tokens are not recorded anywhere |
| Prompt | `buildPrompt` (has a `needDocumentGeneration` section, always `false` today) | Own `GENERATION_INSTRUCTIONS` / `REVISION_INSTRUCTIONS` (reuses `IDENTITY_INTRO` + `DOCGEN_FULL`) |

**Goal:** the teacher asks for a document in the chat ("faz uma prova de 10 questões sobre o capítulo 3 que eu mandei"). The judge recognises it, picks the document type and a strong enough model. If the header details are missing, MATIAS asks for them first. Then the server builds the document with the conversation's context, and the stream reports progress and the new document. Asking for changes in the chat revises the same document.

The structured document engine stays as it is: Zod schemas, `assignIds`, `applyPatch`, the renderers, credits and versioning. **The chat becomes its only AI entry point.** The goal is fewer endpoints and less overhead.

## Decisions (2026-11-22)

1. **A document turn spends both** a chat message (`messagesPerCycle` for the tier it ran on) **and** a document credit, following the existing credit rules. A turn where MATIAS only asks for header details spends just the chat message.
2. **Documents never run on CHEAP.** The judge picks **NORMAL or EXPENSIVE** from how demanding the document is, and code enforces it, including when the user picked CHEAP by hand. See §1.
3. **The old AI routes are removed:** `POST /documents/assessments`, `POST /:id/revise` and `POST /:id/regenerate` go in the same release as the chat path, not later. Only the non-AI routes stay (GET, PATCH, renders). See §6 for merging those too.
4. **Header details come from a conversation.** MATIAS asks the teacher for what's missing, then reads the answers from the chat history. There is no header field in any request body. Filling the header from Classroom (class name, subject, teacher) comes later, in Phase 7.

## What stays, what goes

| Piece | Decision |
| --- | --- |
| `AssessmentAiService` (JSON mode, Zod gate, one retry, patch engine) | **Stays.** It becomes a service the chat calls. It gets the model id from the turn and returns token usage. |
| `AssessmentsService.generate / revise / regenerate` | **Stay** as domain operations (credits, locks, versions). The chat calls them; no controller does. |
| `POST /documents/assessments`, `POST /:id/revise`, `POST /:id/regenerate` | **Removed** (Phase 3), with their DTOs in `documents.controller.ts`. |
| `GET /:id`, `PATCH /:id`, `preview`, `pdf`, `docx`, `answer-key`, `answer-key/preview` | **Stay** (no AI). §6 proposes merging the five render routes into one. |

## Design

### 1. The judge classifies document requests and bumps the model

`JudgeModel.classify` gets one more field in its JSON answer:

```jsonc
"document": {
  "action": "NONE" | "CREATE" | "REVISE" | "REGENERATE",
  "type": "assessment",           // from the document type registry; required unless NONE
  "targetId": "uuid",             // REVISE / REGENERATE only: which document of this conversation
  "complexity": "STANDARD" | "ADVANCED"   // CREATE / REGENERATE only; drives the model bump
}
```

- **Types come from a registry, like the tools do.** `TOOL_NAMES` already feeds both the judge prompt and its response schema. Document types get the same: `DOCUMENT_TYPES` with one-line summaries for the judge. Today there is only `assessment` (prova, lista de exercícios, simulado). New presets from `document-blocks.md` Step 5 register there, and the judge offers them automatically.
- **The judge sees the conversation's documents.** `buildJudgePrompt` gets the list `{ id, type, title }` for the conversation. `ClassroomToolsService.listConversationAssessments` already runs a similar query, and both should share it. Without that list, the judge cannot tell "change question 3" (REVISE) from "make another test" (CREATE).
- **Validation is done by code, not trusted to the judge.** A `targetId` that is not in the list falls back to the newest document. REVISE with no documents becomes CREATE.
- **Model bump.** This is new judge prompt text, and code enforces it:

  | Action | complexity | Model |
  | --- | --- | --- |
  | CREATE / REGENERATE | STANDARD (short quiz or exercise list, one topic, ≤ ~15 questions, no source file) | **NORMAL** |
  | CREATE / REGENERATE | ADVANCED (long or multi-topic test, grounded in uploaded files, exam-style questions such as ENEM or FUVEST, mixed question kinds with an answer key that needs reasoning) | **EXPENSIVE** |
  | REVISE | — | at least **NORMAL** (a patch is small; ADVANCED isn't needed) |

  - In `planTurn`, after the judge: `model = max(chosenTier, requiredTier)`. This applies to AUTO and also to MANUAL picks below the required tier.
  - The `status: generating` event gets `upgradedFrom` (the mirror of today's `downgradedFrom`), so the frontend can show "usando o modelo Expert para gerar a prova".
  - **Quota:** if the required tier has no messages left, try the next tier up (NORMAL → EXPENSIVE). If neither has quota, send an `error` event with the quota body. Never fall back to CHEAP for a document. `UsageService.pickAvailableModel` gets a `minimum` tier argument.

### 2. Asking for header details, then reading them from history

The header (school name, teacher name, subject, class) has no form any more, so MATIAS gets it in the conversation:

- **Judge field:** `document.missingHeader: ("institutionName" | "teacherName" | "subject" | "className")[]`. These are the fields the judge did not find in the history or the current message.
- **When to ask:** on a CREATE where `missingHeader` is not empty and MATIAS **has not asked yet in this conversation**, the turn doesn't generate. The chat model gets a `DOCUMENT_ASK_HEADER` prompt section listing the missing fields. It asks for them all in one short message and says the teacher can skip. This turn spends one chat message and no document credit. It is stored as `metadata.document = { action: "ASK_HEADER", missing }`, which is how "already asked" is detected next time, with no extra table.
- **Next turn:** the teacher answers ("Escola Estadual X, Prof.ª Ana, 7º A"). The judge sees the earlier request and the answer in the history and returns CREATE with nothing missing. If the teacher skipped or said "tanto faz", the judge still returns CREATE, and because MATIAS already asked, it generates with whatever is known.
- **Filling the header:** the document AI call returns the content **and** a `header` object with the text fields only (`institutionName`, `teacherName`, `subject`, `className`), taken from the conversation. Today the header is "never produced by the AI". That rule now narrows to "the AI may only copy what the teacher wrote". The prompt says "only values the teacher stated; leave the field out otherwise", and the `logo` and the visible `fields` stay out of the AI schema.
- **Theme:** defaults, as now. The teacher changes it by asking in the chat (REVISE produces `update_theme`) or with a manual `PATCH`.

### 3. Context the document AI receives

A new `DocumentContextBuilder` builds the request text from:

1. **The teacher's message.**
2. **Conversation history:** the last 20 messages, already loaded in `streamAnswer`, trimmed to a token budget. This includes the header answers from §2.
3. **RAG chunks:** when the judge sets `retrieve` and the conversation has documents, with a larger `limit` (10) than chat's 5. The prompt says the questions must be grounded in these excerpts.
4. **For REVISE / REGENERATE, the current document:** what `revise` sends today (`content`, `theme`, `headerFields`, never the logo).
5. **Classroom context:** Phase 7 (§7).

All of it goes into the *user* content, so the type's system instruction stays a cacheable prefix. The teacher's personal data is never added beyond what they wrote; the whole-user-row leak was removed with the old `chat()`.

### 4. Stream flow (`AiService.streamAnswer`)

```
start
status: classifying                 ← judge (now also returns document)
status: retrieving                  ← RAG, when retrieve
status: documenting {action, type}  ← NEW (skipped on ASK_HEADER)
document {id, type, title, version, action}   ← NEW, after the document is saved
tool …                              ← Classroom tools (they can now see the new document)
status: generating {model, upgradedFrom?, …}
text …                              ← short chat answer, or the header question
done
```

- **Order matters.** The document is built before tools are resolved, so `listConversationAssessments` includes it. "Faz uma prova e posta como tarefa na turma 7A" works in one turn.
- **Quota:**
  - **Chat message:** counted for the tier the turn ran on, as today.
  - **Document credit:** `getDocumentAllowance` + `assertCanSpendDocumentCredit` (CREATE) or `extraCreditNeeded` (REVISE / REGENERATE). Checked after the judge, inside the stream.
  - A `QuotaExceededException` / `PlanRestrictionException` becomes an `error` event, the same path chat quota uses today. The credit is recorded only when the document is saved.
- **Chat answer:** `buildPrompt` gets `needDocumentGeneration: true` and a short dynamic section with what was produced (type, title, number of sections and questions, total points, or the ops applied). The model must not repeat the questions in the chat; the document is the source of truth.
- **Failures:**
  - The document AI fails (502), or no valid patch comes back (422): no credit is spent, a `document_error` status is emitted, and the chat answer explains in plain language.
  - A 409 can't happen, because the server reads the latest version itself.
- **Abort:** if the client disconnects while the document is generating, let the generation finish and save it, so the credit isn't wasted. The next turn sees the document in the list.

### 5. One model catalog, one Gemini client

- Move the model ids into `src/ai/models/model-catalog.ts`: `CHEAP = gemini-3.5-flash`, `NORMAL` / `EXPENSIVE = gemini-3.8-flash`, `JUDGE = gemini-3.1-flash-lite`, plus `maxOutputTokens` per tier.
- `AssessmentAiService.generate / revise` take `{ model, thinkingLevel }` from the turn. Document output keeps `MAX_OUTPUT_TOKENS = 8192` whatever the tier.
- One injectable `GeminiClient` provider replaces the client inside each model class and inside `AssessmentAiService`.
- **Records:** `MessageMetadata.document = { id, type, action, modelName, latencyMs, tokens, attempts }` (or `{ action: "ASK_HEADER", missing }`). This fixes "tokens spent on documents are not recorded" (item 8 in `document-generation.md` §7). `assessments.conversationId` is always set, and `assessments.prompt` stores the teacher's message.

### 6. Fewer routes for the document module (proposal)

The five render routes could become one:

```
GET /documents/assessments/:id/render?format=html|pdf|docx&part=exam|answer-key
```

- It goes from 7 routes to 3: `GET /:id`, `PATCH /:id` and `GET /:id/render`.
- `docx` + `answer-key` returns 400 until a DOCX answer key exists.
- The CSP and `no-store` headers apply when `format=html`.

This is separate from the chat work; do it in the same release only if the frontend changes anyway.

### 7. Classroom as a context source (later, Phase 7)

When Classroom is connected, MATIAS can fill the header and the brief from it instead of asking:

- **Before asking:** if `className` or `subject` is missing, call `classroom_list_courses` and offer the matches ("É para a turma 7º A — Ciências?") instead of a blank question.
- **Header values:** take `className` from the course `name` / `section`, `subject` from the course name, and `teacherName` from the connected Google account's name.
- **Grade level for the content:** take it from the course name or section when the teacher didn't state it.
- **Privacy:** the existing rule still holds. Only the course fields and the teacher's own name are used, and no student data goes into a document.

## Phases

| # | Phase | Main files | Done when |
| --- | --- | --- | --- |
| 0 | Model catalog and shared Gemini client; `AssessmentAiService` takes the model and returns usage | `src/ai/models/*`, `src/documents/ai/document-ai.service.ts` | Same behaviour, nothing hard-coded twice |
| 1 | Document type registry (`assessment`); judge `document` field (action, type, targetId, complexity, missingHeader); conversation document list in the judge prompt | `src/ai/dto/judge-response.dto.ts`, `src/ai/constants/prompts.ts`, `src/ai/models/judge-model.ts` | The judge returns a valid `document` for create, revise, regenerate, ask and none |
| 2 | Model bump in `planTurn` (`max(chosen, required)`, `upgradedFrom`), and `pickAvailableModel` with a minimum tier | `src/ai/ai.service.ts`, `src/usage/usage.service.ts`, `src/ai/dto/chat-stream-event.ts` | A document never runs on CHEAP. Quota goes up a tier, never down |
| 3 | Stream orchestration: ASK_HEADER turn, `DocumentContextBuilder`, AI-filled header text fields, quota (message + credit), `documenting` / `document` events, metadata, errors, abort, tools after the document. **Remove the three AI `POST` routes.** | `src/ai/ai.service.ts`, new context builder, `src/documents/ai/*`, `src/documents/schemas/content.schema.ts`, `src/documents/documents.controller.ts`, `src/db/schemas/message.ts` | The events stream in order. A document is saved and charged once. The old routes are gone |
| 4 | Chat answer: `needDocumentGeneration`, the produced-document summary, `DOCUMENT_ASK_HEADER` | `src/ai/constants/prompts.ts` | The answer summarises without repeating questions, and asks for header details once |
| 5 | Docs: `README.md`, `_test.http` (document turns replace the old POSTs), spec updates | — | — |
| 6 | *(Optional)* Merge the render routes into `GET /:id/render` | `src/documents/documents.controller.ts` | 3 document routes |
| 7 | *(Later)* Classroom as a context source (§7) | `src/classroom/*`, context builder, prompts | The header is proposed from Classroom when connected |

## How it fits with `document-blocks.md`

That plan (block kinds, document types as presets, `/documents/...` routes) is still pending, and the two plans don't depend on each other. Doing **this plan first** gives the chat experience with the one type that exists. A new type later is a preset plus one registry line, and the judge offers it with no change to the chat code. If `document-blocks.md` renames the routes to `/documents/:id`, §6 applies to those names instead.

## Verification

- Unit specs, following `AGENTS.md`:
  - judge schema and prompt (document field, registry, target fallback, complexity, missingHeader);
  - the bump rule in `planTurn`, including a MANUAL CHEAP pick;
  - `pickAvailableModel` with a minimum tier;
  - `DocumentContextBuilder`.

  `AiService` has no spec today. One for the document branch of `streamAnswer` will be suggested, not added without your OK.
- `npx tsc --noEmit`, `npm run lint`, `npm test`. The 39 failures in auth, payment and subscription already exist.
- Manual tests in `_test.http`, against real Gemini:
  1. "Faz uma prova de ciências": MATIAS asks for school, teacher and class (ASK_HEADER, no credit spent). Answer in the next turn → `documenting`, then `document`, and the header in the preview is filled.
  2. A test from an uploaded PDF in the same conversation: `retrieving`, then a document run on EXPENSIVE (ADVANCED), with questions grounded in the file.
  3. With `model: "CHEAP"` in the body: the turn runs on NORMAL with `upgradedFrom: "CHEAP"`.
  4. "Troca a questão 2": REVISE on the same id, version + 1, no new credit within the included changes.
  5. Create and post to Classroom in one turn: `document`, then `tool` events.
  6. No document credits left → an `error` event with the quota body, and nothing saved. No NORMAL or EXPENSIVE messages left → an `error` event, with no fallback to CHEAP.
  7. Disconnect mid-generation: the document is still saved and charged once.
  8. `POST /documents/assessments` → 404.

## Implementation notes (2026-11-22)

### Where things live

| Piece | File |
| --- | --- |
| Model ids, output budgets, `maxTier` | `src/ai/models/model-catalog.ts` |
| Shared Gemini client (`GeminiClient`, `GeminiModule`) | `src/ai/gemini.client.ts` |
| One chat model class for every tier (replaces `cheap/normal/expensive.model.ts`) | `src/ai/models/gemini-chat.model.ts` |
| Document type registry | `src/documents/document-types.ts` |
| Judge `document` field (malformed → `NONE`) | `src/ai/dto/judge-response.dto.ts`, `src/ai/models/judge-model.ts`, `buildJudgePrompt` |
| Intent, model floor, context, run, summary | `src/ai/document-turn.service.ts` (+ spec, 100% coverage) |
| Turn orchestration and bump | `AiService.planTurn` / `streamAnswer` |
| `pickAvailableModel(allowance, preferred, minimum)` | `src/usage/usage.service.ts` |
| AI-filled header text (`aiHeaderSchema`, `aiAssessmentDraftSchema`) | `src/documents/schemas/header.schema.ts`, `content.schema.ts` |
| Failure reason of the document AI (`documentAiFailure`) | `src/documents/ai/document-ai.service.ts` |

### Where the code differs from the plan

- **One chat model class.** The three model classes differed only in settings, so they became `GeminiChatModel(client, tier)`.
- **Plain chat keeps its old fallback.** `pickAvailableModel` searches upward only when `minimum` is above CHEAP. A plain chat turn that runs out of CHEAP still gets the quota error, as before.
- **Clamped thinking level.** When a MANUAL CHEAP pick is raised to a bigger tier, the requested thinking level is clamped to the plan's maximum. A CHEAP pick skips that check in `loadAllowance`.
- **Version handling.** `AssessmentsService.revise` and `regenerate` no longer take a `version` from a client. They work on the latest version, and a concurrent manual `PATCH` still gives a 409 at save time, which shows up as `GENERATION_FAILED`.
- **Regenerate keeps the header.** The current header wins, and header text from the AI only fills fields that are empty.
- **Document list not shared yet.** `ClassroomToolsService.listConversationAssessments` still has its own query. The judge's list uses the new `AssessmentsService.listByConversation`. Merging them would mean changing the Classroom spec.
- **Message saved without text.** The IA message is saved even when the answer text is empty (for example, the client left during the document), so the document's tokens are always recorded.

### Known gaps

1. **Header text can't change after creation.** Neither `PATCH` (`update_header_fields` only shows or hides the blank fields) nor a chat revision can set the school name, teacher, subject or class. If the teacher skipped the question, the only way to fill them is to redo the document. Next step: a `set_header_text` patch operation for manual edits and the AI.
2. **Not tested against real Gemini.** The judge's new field, the ask-once flow and the AI-filled header still need the manual tests in [Verification](#verification). `_test.http` has requests [6.1] to [6.5c] for them.
3. **No `AiService` spec yet.** The bump and orchestration in `planTurn` / `streamAnswer` are covered only by the manual tests. `pickAvailableModel` with `minimum` also has no spec, because `UsageService` has none.
4. **The e2e test was updated mechanically.** `assessment-flow.e2e-spec.ts` got the new constructor and call signatures, with the same assertions, and still passes.

