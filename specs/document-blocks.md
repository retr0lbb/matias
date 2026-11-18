# Plan: generic documents (blocks + types) with conversation context

Single source of truth for the documents module. `specs/document-generation.md` (the first plan, in
Portuguese) is history; `specs/document-credits.md` covers quota.

## Status

| Phase | State |
|---|---|
| 1. Block registry, content schema v2 | done (not committed) |
| 2. Document types as presets, table rename | done (not committed) |
| 2b. Group work type + research/deliverable/rubric blocks | done (not committed) |
| 3. Conversation context, RAG, chat memory | done (not committed) |
| 4. Prompts and the AI service | **next** |
| 5. Verification | revised below |

### Where we stopped (2026-11-18)

- **Last thing done:** Phase 3, finished and verified. Nothing of Phases 1–3 is committed: branch
  `feat/document-generation`, last commit `32ee496`, 30 modified files plus new `src/conversation/`,
  `src/documents/blocks/`, `src/documents/types/`, `src/documents/render/format.ts` and two migrations
  (`20261118182314_document_types`, `20261118185838_group_work_type`).
- **Next step:** Phase 4 (section 5), in this order:
  1. split `src/ai/constants/prompts.ts` into exported pieces (identity intro, *Comunicação* rules,
     `RETRIEVAL_FULL`, `DOCGEN_FULL`) without changing the chat's prompt text;
  2. build the document persona from them (`RETRIEVAL_FULL` only when chunks were retrieved);
  3. `request()` returns `{ text, finishReason, usage, modelVersion, latencyMs }`; `MAX_TOKENS` → 502
     without a retry; usage stored on the chat message `recordTurn` writes (tokens are 0 today);
  4. the Gemini 400 fallback (JSON mode with the schema in the instructions);
  5. then Phase 5.
- **Waiting on you:**
  - run `npm run db:migrate` (two new migrations; not run on your DB);
  - review the four draft prompts in `src/documents/types/*.prompt.ts`;
  - try the real model: the OOP chat followed by "com base na conversa, crie a prova" with that
    `conversationId`, and a group work (largest Gemini schema so far, untested on the real model);
  - `pnpm approve-builds` and `npx playwright install chromium` if not done yet;
  - the frontend changes: routes `/documents/...`, `type`, `header.extra`, `NEEDS_CLARIFICATION`,
    `refreshContext`, `/usage` key `documentGeneration`.

Verified so far, each round: `tsc`, `lint`, the 89 existing document specs, throwaway checks (deleted),
assessment HTML and answer key **byte-identical** to the original code (24 cases), every migration applied
on a throwaway Postgres (your `educacional_postgres` untouched, `db:migrate` never run). You confirmed real
Gemini generation still works after Phase 1.

## 1. What the first review found (all still true until Phase 3 unless marked fixed)

1. **Geography test.** `generate()` only *stores* `conversationId`; the model gets only the request text.
   No history, no RAG, so "based on the conversation" has nothing to be based on. `regenerate` too.
2. **Prompt.** The module doesn't use the chat's prompt builder; your rules (sources, exam questions)
   had no fields to land in. *Fixed in Phase 1:* `reference` and `sources` on questions.
3. **Hard-coded for tests.** *Fixed in Phases 1–2.*
4. **Output budget and visibility.** *Budget per type: fixed in Phase 2.* `request()` still returns only
   text, so `MAX_TOKENS` looks like invalid JSON, and document token usage is not recorded (Phase 4).
5. **No code blocks.** *Fixed in Phase 1.*
6. **Get-or-create conversation duplicated** in `AiService` (twice) and `DocumentsService` (Phase 3).

## 2. Model

- **Five types** (presets in `src/documents/types/`):

  | type | label | blocks | answer key | header student fields | budget |
  |---|---|---|---|---|---|
  | assessment | Avaliação | multiple_choice, open_ended, text, code | Gabarito | name, date, class, score | 16k |
  | homework | Tarefa | multiple_choice, open_ended, text, list, code | Gabarito | name, date, class | 16k |
  | lesson_plan | Plano de aula | text, list, table | — | — | 8k |
  | course_syllabus | Plano de ensino | text, list, table | — | — | 16k |
  | group_work | Trabalho em grupo | text, list, table, research_task, deliverable, rubric | Guia de correção | group members, date, class, score | 16k |

- **Nine block kinds** (`src/documents/blocks/`, one file each, listed in `registry.ts`):
  - scored (numbered questions, `statement`, `points`, `reference?`, `sources?`): `multiple_choice`
    (+ `explanation`), `open_ended`;
  - content: `text`, `list`, `table`, `code`;
  - group work: `research_task` (question, topics, guiding questions, suggested sources, citation style;
    teacher-only `expectedFindings`), `deliverable` (format, description, length, required sections,
    formatting; teacher-only `expectedOutline`), `rubric` (criteria with points and description;
    teacher-only `guidance`).
- A block may add **points without being a question** (`pointsOf`): the rubric's criteria are a group
  work's value, so "Valor" and "Nota: __ / N" work the same as for a test.
- **Teacher-only fields** are rendered only in the answer key. For group work that document is the
  *Guia de correção*: expected findings, expected outline per part, grading guidance per criterion.
- **Header:** `extra` labelled values (teacher-set); `groupMembers` prints 5 blank "Integrantes" lines.
  Both optional with no default, so stored documents parse unchanged.

## 3. Revisions to the plan (made in this review, before Phase 3)

1. **"No guessing topics" no longer uses a root union.** Gemini has only been proven with unions *inside*
   the document. Instead the AI content gets one optional top-level `clarification` string; a Zod refine
   requires either a clarification or at least one section. With a clarification the API answers 422
   `NEEDS_CLARIFICATION { question }`, spends no credit, stores nothing. Lower risk, same behavior.
2. **No `source` snapshot column.** It would copy chat text into `documents`, and that copy would outlive
   a deleted conversation. `regenerate` instead re-reads the conversation **as it was** when the document
   was created (messages older than `documents.created_at`); `refreshContext: true` reads it as it is now.
   Same stability, no duplicated data, no migration.
3. **History is not "data".** Earlier turns hold the teacher's own requirements ("10 questões, nível
   médio"), so the prompt treats history as *context the request may refer to*. Only **retrieved RAG
   documents** are data-not-instructions (the prompt-injection boundary, as `RETRIEVAL_FULL` already says).
4. **Conversation title.** The judge titles a conversation only when its history is empty, so a document
   generated first would leave it untitled forever. When the conversation has no title, the document's
   title becomes it.
5. **What the chat remembers.** `generate` and `regenerate` record a USER + IA message pair; `revise`
   records nothing (ten small edits would fill the 20-message window and push the real conversation out).
   Note the limit: the chat then *knows* the document exists but cannot *edit* it; editing from the chat
   needs tools (the judge already returns a `tools` field) and is out of this round.
6. **History selection.** USER messages and IA messages with status COMPLETED (aborted or failed stream
   answers are partial and would mislead). Retrieved chunks get a character cap (24k) besides the count
   (12), since chunk size is set in tokens by the chunker.
7. **`revise` gets the same context as `generate`** (history + chunks): "add a question about what we
   discussed" needs the history too.
8. **Prompt language.** Type prompts stay in English (the assessment one is word for word what worked);
   your detailed Portuguese rules are imported from `src/ai/constants/prompts.ts` and not duplicated.

## 4. Phase 3: conversation context, RAG and chat memory

- New `src/conversation/` (module + `ConversationContextService`, imports `RagModule`):
  - `getOrCreate(userId, conversationId?)`: UUID check, 403 on someone else's, creates when missing.
  - `loadHistory(conversationId, { before?, limit: 20, maxCharsPerMessage: 6000, maxTotalChars: 40000 })`,
    newest kept, selection as in revision 6; `before` is the regenerate cut-off (revision 2).
  - `retrieve({ query, userId, conversationId, limit: 12, maxChars: 24000 })` (today's private
    `AiService.retrieveContext`; `RagService.search` gets an optional `limit`).
  - `recordTurn(executor, { conversationId, userContent, iaContent, metadata, tokens })`; sets the
    conversation title when it has none (revision 4).
- `AiService.chat/prepareStream` delegate to it (mechanical extraction, no behavior change);
  `DocumentsService.assertConversationAccess` is replaced.
- Retrieval query = conversation title + last two user messages + request (≤ 1000 chars), because "based on
  the conversation" alone is a useless embedding query. Skipped when the conversation has no READY documents.
- `generate` flow: allowance/thinking checks → `getOrCreate` → history + chunks → model → clarification
  (422) or document → transaction: lock, quota, insert row, ledger row, `recordTurn`.
- Model input becomes labelled parts: conversation history (context), retrieved documents (data), then
  the teacher's request.
- Recorded chat wording is built deterministically, e.g. `Criei a avaliação «Título» com N questões
  (X pontos).` / `Criei o trabalho em grupo «Título» (X pontos).` `MessageMetadata` gains `documentId?`,
  `documentType?`; `tier` becomes optional; `expense` stays null so it never counts as a model message.

## 5. Phase 4: prompts and the AI service

- System prompt per type = identity from `prompts.ts` (`IDENTITY_INTRO` + the *Comunicação* rules of
  `IDENTITY_FULL`, except the clarifying-question rule, which becomes the `clarification` field) +
  `DOCGEN_FULL` for types with questions + `RETRIEVAL_FULL` when chunks were retrieved + the type prompt +
  `aiGuideFor(blocks)` + context rules (revision 3) + structural rules. `prompts.ts` exports the pieces
  instead of one block of text.
- `request()` returns `{ text, finishReason, usage, modelVersion, latencyMs }`: `MAX_TOKENS` becomes a clear
  502 without a wasted retry; usage goes into the recorded chat message.
- Gemini 400 fallback stays: retry in JSON mode with the schema in the instructions, remember it per schema.
  Watch the group-work schema: six kinds with nested objects is the largest union so far.
- You review the four draft prompts (`homework`, `lesson_plan`, `course_syllabus`, `group_work`).

## 6. Phase 5: verification

- `tsc` (only the 3 known auth-spec errors), `lint`, `drizzle-kit check`, document specs.
- Chromium e2e fixtures: one document per type (group work included); look at the PDFs.
- Throwaway checks (deleted): the geography regression with a stubbed Gemini (request contents include the
  OOP conversation and the chunks; empty context → `NEEDS_CLARIFICATION`); regenerate reads only messages
  older than the document; revise records nothing in the chat; title set on an untitled conversation.
- A real-model run per type if the free-tier quota allows; otherwise stated as stubbed. `npm test` not run
  (auth specs broken, per your instruction). No new spec files unless you ask (AGENTS.md).

## 7. Risks

- **Recalled, unverifiable references.** Exam questions (`reference`) and group-work suggested sources come
  from the model's memory. The prompts tell it to cite only what it is certain exists and never invent links,
  and both are visible to the teacher. Web grounding could verify them; untested with JSON output.
- **History cost:** up to 40k characters of history + 24k of chunks per generation.
- **Group members lines** are a fixed 5; a group-size field can come later if needed.

## 8. Not in this round

DOCX, flow e2e, image blocks, editing documents from the chat (tools), micro templates, the Express 100 KB
JSON limit vs the 300k-character logo, `ZodValidationPipe` error detail, `passwordHash` in
`POST /auth/register`, the 22 already-failing subscription specs.

## Appendix: how Phase 3 deviated from what was planned

- The **context rules** (conversation = context, documents = data, ask instead of inventing) went into the
  prompt now, not in Phase 4: the clarification can't work without them. Phase 4 still rebuilds the persona
  from `prompts.ts`. Without any context the request is sent alone, exactly as before; the system prompt
  gained a short "Context:" section for every type.
- One clock for a new document and its chat messages (`createdAt` set by the server; USER at that time,
  IA 1 ms later), so the regenerate cut-off excludes the document's own messages exactly and the chat shows
  the pair in order (inside one transaction Postgres `now()` doesn't move).
- A `conversationId` that doesn't exist yet is created (same rule as the chat), also when the answer turns
  out to be a clarification; it stays empty.
- The documents module now answers someone else's conversation with the chat's 403 text ("Not your chat pal").
- The chat is unchanged (same queries, same 403/400 texts); only its RAG log lines now come from
  `ConversationContextService`.
- Verified on a throwaway Postgres with all 21 migrations (real SQL, stubbed Gemini and RAG): the OOP
  conversation and the chunks reach the model, an aborted answer doesn't; the turn is written back with the
  document id, no `expense`, and the chat quota stays 0; the title is set once; regenerate reads the chat as
  it was and `refreshContext` as it is; revise writes nothing; no subject → 422 with nothing stored and no
  credit; someone else's conversation → 403; no conversation → request alone; and the Nest modules resolve.

## Appendix: how Phases 1–2b deviated from what was planned

- Scored kinds use `defineScoredBlock` (adds `statement`, `points`, `reference`, `sources`), content kinds
  `defineContentBlock`. `code` blocks stay in the answer key; `text`/`list`/`table` don't, and an empty
  section is left out.
- `render/format.ts` was split out of `layout.ts` to avoid an import cycle with the blocks.
- "Valor" is derived (shown when the document has points), not a preset flag.
- The patch request body accepts every block kind (the type isn't known yet when it is validated);
  `applyPatch(document, ops, type)` rejects what the type doesn't allow. The AI patch schema is per type.
- Fixed along the way: exam citations were also requested inside the statement (would print twice);
  a misplaced prompt bullet; header labels weren't HTML-escaped (they now come from the request).
- Migrations: `20261118182314_document_types` (hand-written rename, snapshot grafted from a fresh
  generate) and `20261118185838_group_work_type` (`ALTER TYPE ... ADD VALUE`). `generate` reports no
  pending changes.
