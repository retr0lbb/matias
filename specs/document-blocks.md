# Plan: block-based documents (scalable JSON → HTML)

## Context

The document module only knows "assessment": the content schema, renderer, answer key, patch operations and AI prompt each hard-code `multiple_choice | open_ended` (33 references in 10 files). Adding a field kind today means editing all of them; adding a document type means copying the module.

Decisions taken with you:

- **One block model.** Every document is header + theme + sections of **blocks**. A block kind is one self-contained file. A document type is a small preset.
- **This round:** the architecture, the two existing kinds moved onto it, plus two new kinds as proof (`drawing_area`, `text`). Only the `assessment` type exists, but nothing outside its preset may assume it.
- **Rename freely:** nothing consumes the current names.
- **Later, not now:** image blocks (need upload storage), rubric block, homework type, micro templates.

## Step 0 — record the current state (before any code)

1. Add a section **"7. Estado atual, mudanças e pendências"** to `specs/document-generation.md` (in Portuguese, like the file):
   - **Estado:** Fases 0–4 feitas (4 ainda sem commit); 5 (DOCX) e 6 (fluxo e2e) pendentes.
   - **Mudanças em relação ao plano:**
     - rota de debug removida;
     - `POST` aceita `header`/`theme`;
     - `/answer-key` devolve PDF e existe `/answer-key/preview`;
     - colunas `prompt` e `ai_revisions`; `regenerate` aceita `prompt` opcional;
     - dono errado responde 404, não 403;
     - `revise` usa modo JSON sem `responseJsonSchema`;
     - modelo `gemini-3.5-flash`;
     - cota: 30 créditos/ciclo, 7 mudanças por IA por crédito, patch manual grátis;
     - fases 1–4 sem specs unitários (ficaram com você);
     - `specs/document-builder.md` removido.
   - **A investigar:**
     - Gemini responde 400 ao schema de patch. Sabemos: união com 1 operação passa, com 4 operações simples falha; trocar o formato de `nullable` ou remover grupos de operações não resolveu; `oneOf`→`anyOf` não chegou a ser testado. A união de 2 tipos de questão da geração funciona.
     - `revise` nunca rodou contra o modelo real (só com cliente simulado).
     - Free tier: 20 requisições/dia por modelo; `gemini-3.8-flash` devolveu 503/504.
     - Cota: mudanças extras em documento de ciclo anterior não são cobradas (precisa de ledger); confirmar a leitura da regra dos 7.
     - Limite de 100 KB do JSON do Express contra logo de até 300 mil caracteres.
     - `ZodValidationPipe` responde "Validation failed" sem detalhes (ruim para `PATCH`).
     - Tokens gastos pela IA em documentos não são registrados.
     - `POST /auth/register` devolve `passwordHash`.
     - Specs de `auth` quebrados (3 erros de `tsc`).
     - A conta do `_test.http` não existe no banco local.
2. Save this plan as `specs/document-blocks.md`.

## Step 1 — block kinds as self-contained files

New folder `src/documents/blocks/`:

- `block.ts`: `defineBlock({...})` and its types. A definition holds:
  - `kind`, `shape` (Zod fields, unrefined), optional `refine` (cross-field rules such as `correctIndex`);
  - `scored`: true = numbered question with `statement` + `points`; false = content block (not numbered, no points);
  - `renderHtml(block, { number })`, optional `renderAnswer(block, { number })` (absent = left out of the answer key);
  - `css` (only that block's rules) and `aiGuide` (the lines the prompt needs about that kind).
  - `defineBlock` derives `aiSchema` (no id) and `storedSchema` (with id) the way `content.schema.ts` does today.
- `multiple-choice.block.ts`, `open-ended.block.ts`: today's shapes, HTML, answer output, CSS and prompt lines moved from `content.schema.ts`, `render-html.ts`, `render-answer-key.ts`, `styles.ts`, `assessment-ai.service.ts`.
- `drawing-area.block.ts` (scored): `statement`, `points`, `heightMm` (20–200, default 60), optional `expectedAnswer`. Renders a bordered blank box.
- `text.block.ts` (not scored): optional `title`, `body`. Reading passage / notice.
- `registry.ts`: the list of kinds; exports the AI and stored discriminated unions, `definitionOf(kind)`, the concatenated block CSS, and `aiGuideFor(kinds)`.

Adding a field kind afterwards = one new file + one line in `registry.ts`.

## Step 2 — content schema v2

- `schemas/content.schema.ts`: `sections[].questions` → `sections[].blocks`, built from the registry unions. Duplicate-id check stays.
- `schemas/document.schema.ts`: `schemaVersion: 2`; add `upgradeDocument(raw)` (v1 → v2 renames `questions` → `blocks`), called in the service before parsing, so stored rows keep working and are rewritten as v2 on their next save.
- `build/assign-ids.ts`: generic over blocks (`assignBlockId`, `assignSectionIds`, `assignIds`); id prefix `q` → `b`.

## Step 3 — rendering through the registry

- `render/layout.ts`: `numberQuestions` → `numberBlocks`: only `scored` blocks get a number and count toward `totalPoints`.
- `render/render-html.ts`: keeps the page shell, header and section; each block goes through `definitionOf(block.kind).renderHtml`. `renderQuestionHead` becomes a shared helper for scored blocks.
- `render/render-answer-key.ts`: uses `renderAnswer`; blocks without it are skipped.
- `render/styles.ts`: base CSS (page, header, section, question head) + registry CSS.
- Header rendering stays one function fed by a plain view model (title, total, fields). That is the seam for the future micro templates; nothing more is built for them now.

## Step 4 — patch and AI follow the blocks

- `schemas/patch.schema.ts` + `patch/apply-patch.ts`: `replace_question / insert_question / remove_question / move_question` → `replace_block / insert_block / remove_block / move_block` (`blockId`, `afterBlockId`). Logic unchanged.
- `ai/` service: prompts are assembled from a type's own text + `aiGuideFor(allowedBlocks)`; the Gemini schema comes from the type's AI schema.
- Because the patch union was rejected with 400 and the block union is now growing, `request()` gets one fallback: on a 400 for a structured call, retry in JSON mode with the schema in the instructions (the path `revise` already uses) and remember it for that schema. Zod stays the gate in both paths.

## Step 5 — document types as presets

- `src/documents/types/document-type.ts`: `DocumentTypeDefinition` = `type`, `label`, `allowedBlocks`, `hasAnswerKey`, `showsScore` (header "Valor"/"Nota"), AI generation text.
- `types/assessment.type.ts`: today's behavior as the first preset (all four kinds allowed). `types/registry.ts`: lookup by `type`.
- The schema for a type = shared document schema + "block kind allowed for this type".
- Table `assessments` → `documents` with a `type` column (`src/db/schemas/document.ts`, new migration).
- Routes `/documents/assessments/...` → `/documents/...`; `POST /documents` takes `type` (default `assessment`). Service/controller/module renamed to `Documents*`; folder `src/documents/assessment/*` flattens into `src/documents/*`.
- Quota names follow: `assessmentsPerCycle` → `documentsPerCycle`, code `DOCUMENTS_PER_CYCLE`, `/usage` key `documents` (`src/usage/plans.ts`, `usage.service.ts`, `quota-exceeded.exception.ts`).
- `_test.http` updated to the new routes and op names.

## Things that need your OK (they touch your territory)

- **Existing spec files** (`content.schema.spec.ts`, `assign-ids.spec.ts`, `document.schema.spec.ts`, ...) reference `questions` and the old paths, so they break on the rename. I will move them with their source and apply only the mechanical renames; I will not add or redesign tests. The Chromium e2e spec gets the same treatment plus the two new kinds in its fixtures.
- **Migration for the table rename:** `drizzle-kit generate` asks interactively whether a table was renamed. If it cannot be answered from here, I will ask you to run it.

## Not in this round

Image block and upload storage, rubric block, homework type, micro templates, DOCX (Phase 5), flow e2e (Phase 6), and the investigations listed in Step 0 other than the AI fallback above.

## Verification

- `npx tsc --noEmit` (only the 3 known auth errors) and `npm run lint`.
- `npm run test:e2e` (Chromium): existing fixtures plus one with `drawing_area` and `text`; check page count, text present, answers absent, and look at the PDFs written to `.tmp/assessment-pdf`.
- Throwaway checks, deleted afterwards (as in Phase 4): every patch op on v2 content; a stored v1 document upgrades and renders identically to before; a block kind not allowed by the type is rejected.
- Local server smoke test over HTTP without the AI where possible (manual `PATCH` inserting a `drawing_area` and a `text` block, preview, PDF, answer key, 409/422/404). Generation and `revise` against the real model only if the Gemini quota has reset; otherwise with the stubbed client, stated as such.
- `npm test` is not run (your instruction); moved spec files are run individually only to confirm the mechanical renames compile.
