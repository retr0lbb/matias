# Message metadata (AI token & model info)

> **Update (2026-11-22):** `POST /ai/chat`, `AiService.chat()` and every model's `generate()` were removed. `POST /ai/chat/stream` is now the only chat route, and models only implement `generateStream()`. Passages below about the non-streaming path are history.

Store generation metadata on every IA message, from both `chat()` and `streamAnswer()`.

## Decisions

- `messages.metadata` (jsonb, no migration needed) holds `MessageMetadata`:
  - `tier` — CHEAP / NORMAL / EXPENSIVE
  - `modelName` — model requested (constant in the model class)
  - `modelId` — `modelVersion` Gemini actually returned
  - `thinkingLevel`, `finishReason`, `latencyMs`
  - `tokens` — `{ prompt, output, thoughts, cached, total }` from Gemini `usageMetadata`
  - `thinking` — thought-summary text, when the model returned it
  - `judge` — `{ modelId, latencyMs, tokens }` for the classifier call of the same turn
- `temperature` removed (nothing sets it).
- `outputTokens` column fixed: now `candidates + thoughts` (billed output). It used to be `totalTokenCount`.
  `inputTokens` stays `promptTokenCount`.
- `generate()` now asks for `includeThoughts: true` so thinking text can be stored.
  Cheap streaming keeps `includeThoughts: false` (unchanged UI behaviour).
- Aborted/failed streams still save `tier`, `judge` and partial `thinking`; generation fields are
  only present when the model finished.
- The public `usage` shape in `AIResponse` / SSE `done` event is unchanged.

## Files

- `src/db/schemas/message.ts` — new `MessageMetadata` type
- `src/ai/ai-provider.type.ts` — `AIResponse` gains `tokens`, `modelName`, `thinkingLevel`
- `src/ai/models/gemini-response.ts` — shared `toTokenUsage`, `extractThoughts`
- `src/ai/models/gemini-stream.ts`, `cheap/normal/expensive.model.ts` — fill the new fields
- `src/ai/models/judge-model.ts` — `classify()` also returns `usage` metadata
- `src/ai/ai.service.ts` — build and persist metadata in both paths
