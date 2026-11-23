# Plan: merging `main` (chat-driven documents) into `feat/document-generation` (blocks + types)

Status: **conflicts resolved, merge not committed** (2026-11-23). See [Verification](#verification) and
[Open points](#open-points).

## Context

`git merge main` into `feat/document-generation` brought two lines of work on the document module
that never saw each other:

| | Branch (`1f7062b`, 2026-11-18, `document-blocks.md`) | `main` (2026-11-21/22, `document-generation-in-chat.md`) |
| --- | --- | --- |
| Data model | 9 block kinds, 5 document types, table `documents` with `type` | `assessments` with `questions` (2 kinds) |
| AI entry | `POST /documents`, `/:id/revise`, `/:id/regenerate` | only the chat stream; the AI POST routes are removed |
| Context | `ConversationContextService` (history, RAG, `recordTurn`, 422 `NEEDS_CLARIFICATION`) | `DocumentTurnService` (`buildDocumentRequest`, `ASK_HEADER`, judge `document` field) |
| Model | hard-coded `gemini-3.5-flash`, per-type output budget | model from the turn (`MODEL_IDS`), shared `GeminiClient`, token usage returned |
| Export | HTML / PDF / answer key | + DOCX (assessment only) |

## Decisions (asked 2026-11-23)

1. **Combine both.** The branch's blocks, types and `documents` table are the data model; main's chat
   stream is the only AI entry point. The three AI `POST` routes stay removed.
2. **Main runs the turn.** The chat stream saves the messages (no `recordTurn` pair from the documents
   service). `ConversationContextService` stays for `getOrCreate`, `loadHistory` and `retrieve`.
   An AI `clarification` becomes MATIAS's chat answer, with no credit spent.
3. **DOCX for every block kind** (all 5 types export to Word).
4. **Migrations re-dated after `20261122050422_google_integrations`** (main's are applied on real
   databases; drizzle skips a migration older than the last applied one).

## Changes

### Documents module
- `DocumentsController` at `/documents`: `GET /:id`, `PATCH /:id`, `preview`, `pdf`, `docx`,
  `answer-key`, `answer-key/preview`. No AI routes.
- `DocumentsService.generate / revise / regenerate`: chat-facing signatures from main (`request`,
  `model`, `thinkingLevel`, `prompt`, `conversationId`) plus `type`. Return `{ view, usage }`, or for
  generate/regenerate `{ clarification }`. No context loading and no `recordTurn` inside.
  `listByConversation` returns `type` too. `renderDocx` per type.
- `DocumentAiService`: branch prompts per type (blocks guide, context rules, clarification) + main's
  `GeminiClient`, model from the turn, `UsageMeter`, `documentAiFailure`, AI header text
  (`aiDraft` schema). Output budget stays per type.
- `content.schema.ts`: `createContentSchemas` also returns `aiDraft` (content + `header`).
  `header.schema.ts`: branch schema + `aiHeaderSchema` / `AI_HEADER_FIELDS`.
- DOCX: each block definition gets `renderDocx`; `render-docx.ts` keeps page, header (with `extra`,
  `groupMembers`, per-type student fields, "Valor" only with points) and sections.

### Chat side
- `src/documents/document-types.ts` (main) is removed: the judge reads `DOCUMENT_TYPES` and a new
  `judgeSummary` from the type presets, so all 5 types are offered.
- `DocumentTurnService`: uses `DocumentsService`; `summarizeDocument` is generic over blocks; a
  clarification becomes a `CLARIFY` prompt status (no credit, the model asks the question).
- `AiService`: branch's extraction to `ConversationContextService` + main's stream, tools,
  conversation list/rename/delete. Non-stream `chat()` stays removed (main removed it).
- `ClassroomToolsService`: `documentsTable` / `DocumentsService`; tool argument name unchanged.

### Database
- Delete `20261118182314_document_types` and `20261118185838_group_work_type`; one new migration
  after `20261122050422` with the rename, the `document_type` enum (5 values) and the `type` column.

### Specs and docs
- Spec files are changed only mechanically (renames, new signatures); no new tests.
- `_test.http`: main's chat requests + `/documents/...` routes.

## Verification

- `npx tsc --noEmit`: clean (whole repo, specs included).
- `npm run lint`: no warnings in `src/ai`, `src/documents`, `src/conversation`, `src/classroom`, `src/db`, `src/rag`.
- Unit specs of the merged areas (`src/documents`, `src/ai`, `src/classroom`, `src/conversation`,
  `src/rag`, `src/usage`): 13 files, 277 tests pass. The full `npm test` was not run (standing instruction
  while the auth specs were broken).
- `npm run test:e2e`: `assessment-flow.e2e-spec.ts` passes (generation, retry, HTML, PDF, DOCX, answer key,
  patches). `pdf-renderer.e2e-spec.ts` has 1 failure that already existed on `main` (`multiSectionAssessment`
  gives 2 pages instead of 1 with the current Chromium; `document-generation.md`, "A investigar" 0).
- Throwaway check (deleted): one document per non-assessment type, covering all 9 block kinds, rendered
  to DOCX and read back with `mammoth`. Student text is there, teacher-only fields are not, and the
  header follows the type.
- `drizzle-kit generate`: no schema changes. `drizzle-kit check`: fine.

## Open points

1. **`AiService.deleteConversation` / `renameConversation` (from `main`) don't check ownership**: they
   act on any conversation id. Not changed here (source bug, out of the merge's scope).
2. **Classroom tools still say "assessment"**: the tool argument is `assessmentId` and the prompt lists
   "Avaliações desta conversa", but the list now holds every type. Works; wording only.
3. **The clarification path has no spec** (`DocumentTurnService.run` → `CLARIFY`, `DocumentsService`
   returning `clarification`). The mechanical spec updates didn't add tests.
4. **A database that already ran the old `20261118*` migrations** (the other machine, if `db:migrate`
   was run there) would fail on `20261123120000_document_types`. Such a database needs that migration
   marked as applied by hand.
5. Not run against real Gemini: the five types through the chat, the AI-filled header for non-assessment
   types, and the clarification.
