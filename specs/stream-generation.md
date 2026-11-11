# Especificação: geração de chat via stream (SSE)

## Context
`POST /ai/chat` waits for the full Gemini answer (`provider.generate()` → `generateContent`) before responding, so the user sees nothing until generation ends. We add a parallel streaming path: a new `POST /ai/chat/stream` route that sends tokens as Server-Sent Events while they're generated. Constraints from the user:
- Do **not** delete or modify any `generate()` function. Each model gets a new `generateStream()`.
- Do **not** touch `AiService.chat()`. The stream flow duplicates its setup in new methods.
- SSE over POST, prompt in body, `conversationId` in query (same as the current route).
- Events: `start`, `status`, `thinking` (only when the model emits thoughts), `text`, `done`, `error`.
- On client disconnect or mid-stream failure: abort Gemini and **save the partial answer**.
- **Send the first byte as early as possible.** Slow work (judge, usage, RAG) runs inside the stream, not before it (see "Time to first byte").

Verified: `@google/genai` 2.27.0 has `models.generateContentStream(params): Promise<AsyncGenerator<GenerateContentResponse>>`, `config.abortSignal`, `thinkingConfig.includeThoughts`, and `Part.thought`. The SDK calls `:streamGenerateContent?alt=sse` and reads the body incrementally.

## 1. Types: `src/ai/ai-provider.type.ts`
Keep `generate` and `AIResponse` unchanged. Add:
```ts
export type AIStreamChunk =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "done"; response: AIResponse };

export interface AiProvider {
  generate(input: { message: string }): Promise<AIResponse>;          // unchanged
  generateStream(input: { message: string; signal?: AbortSignal }): AsyncGenerator<AIStreamChunk>;
}
```

## 2. Shared stream mapper: `src/ai/models/gemini-stream.ts` (new)
`async function* mapGeminiStream(stream, fallbackModel, startedAt): AsyncGenerator<AIStreamChunk>`:
- For each chunk, iterate `candidates[0].content.parts`. If `part.thought && part.text`, yield `thinking`. Otherwise, if `part.text`, yield `text` and append it to `output_text`.
- Track the latest `responseId`, `modelVersion`, `usageMetadata` and `finishReason` across chunks.
- At the end, yield `done` with an `AIResponse` built the same way `generate()` builds it (`messageId`, `model`, `status`, `created`, `updated`, `output_text`, `thinking_output`, `usage.total_input_tokens`/`total_tokens`).

This keeps the 3 models from triplicating parsing logic. Each model still gets its own function.

## 3. One new method per model (`generate()` untouched)
In `models/cheap.model.ts`, `normal.model.ts` and `expensive.model.ts`, add:
```ts
async *generateStream(input: { message: string; signal?: AbortSignal }) {
  const startedAt = new Date();
  const stream = await this.client.models.generateContentStream({
    model: MODEL,
    contents: input.message,
    config: {
      maxOutputTokens: /* same as generate() */,
      thinkingConfig: { thinkingLevel: /* see table */, includeThoughts: /* see table */ },
      abortSignal: input.signal,
    },
  });
  yield* mapGeminiStream(stream, MODEL, startedAt);
}
```

| Model | `MODEL` | Stream thinking level | `includeThoughts` |
|---|---|---|---|
| CHEAP | `gemini-3.5-flash` | `MINIMAL` (same as `generate()`) | `false` |
| NORMAL | `gemini-3.8-flash` | **`LOW`** (`STREAM_THINKING_LEVEL`) | `true` |
| EXPENSIVE | `gemini-3.8-flash` | `LOW` (same as `generate()`) | `true` |

- NORMAL's `generate()` keeps `THINKING_LEVEL_UNSPECIFIED`. For streaming, the model default could think for several seconds before the first token, so `generateStream` uses a separate `STREAM_THINKING_LEVEL = ThinkingLevel.LOW`.
- Thinking events only appear for NORMAL and EXPENSIVE. CHEAP's `MINIMAL` thinking has nothing worth streaming.
- `AiExpensesFactory` (`ai.factory.ts`) needs no change. `create()` already returns the providers, and they now expose `generateStream`.

## 4. Service: new methods in `src/ai/ai.service.ts` (`chat()` untouched)
The flow is split so that only the checks needing a real HTTP status run before the SSE headers go out.

**`prepareStream(prompt, userId, conversationId?) → ChatStreamContext`** (before headers)
- User lookup (401), UUID check (400), conversation find/create plus the ownership check (403).
- Returns `{ user, prompt, conversation: { id, title }, ragEnabled }`. `ragEnabled` is true only when the client sent a `conversationId`, the same rule as `chat()`.
- Nothing slow happens here: just a few quick DB queries.

**`async *streamAnswer(ctx, signal) → AsyncGenerator<ChatStreamEvent>`** (after headers; never throws)
1. Yield `start` `{ conversationId, title }` immediately.
2. Yield `status` `{ stage: "classifying" }`, then load history (`HISTORY_LIMIT`), `judgeModel.classify`, `usageService.assertCanChat`, and update the title.
3. If `judge.retrieve && ctx.ragEnabled`: yield `status` `{ stage: "retrieving" }`, then `retrieveContext`.
4. `buildRagPrompt`, insert the USER message, `aiFactory.create(judge.model)`.
5. Yield `status` `{ stage: "generating", model, title }`.
6. Run `for await (chunk of provider.generateStream({ message: input, signal }))`:
   - `text` events are forwarded and accumulated into `partial`.
   - `thinking` events are forwarded only.
   - `done` stores the final `AIResponse`.
7. Yield `done` `{ messageId, finishReason, usage }`.

**Errors inside the stream** (status 200 has already been sent):
- `QuotaExceededException` from `assertCanChat` → an `error` event with the same `QuotaExceededBody` the HTTP 429 had (`statusCode`, `error`, `code: "ADVANCED_MESSAGES"`, `message`, `limit`, `used`, `resetsAt`).
- Anything else (judge, RAG, Gemini) → an `error` event `{ code: "GENERATION_FAILED", message: "Generation failed" }`, with the full error logged.
- Client abort → no event (nobody is listening). It's logged as a warning.

**Persistence** (`finally` → `saveStreamedMessage`): this only runs once a model was chosen (the judge succeeded). If the content (full or partial) is non-empty, it inserts the IA message with the same columns as `chat()`:
- `content`: the full text, or the partial text.
- Tokens and `interactionId`: from the final response if it arrived, otherwise `0` and `null`.
- `expense`: the judge's model tier.
- `messages.status`, which `chat()` leaves null:
  - `COMPLETED`: Gemini finished the answer.
  - `FAILED`: the client disconnected mid-stream; partial text is saved.
  - `ERROR`: Gemini or the server threw mid-stream; partial text is saved.

A completely empty answer stores nothing. A DB failure here is logged, not thrown.

## 5. Events: `src/ai/dto/chat-stream-event.ts` (new)
Each event is written as `event: <type>\ndata: <json>\n\n`.

| Event | Data |
|---|---|
| `start` | `{ conversationId, title }` |
| `status` | `{ stage: "classifying" }` · `{ stage: "retrieving" }` · `{ stage: "generating", model, title }` |
| `thinking` | `{ text }` |
| `text` | `{ text }` |
| `done` | `{ messageId, finishReason, usage }` |
| `error` | `QuotaExceededBody` or `{ code: "GENERATION_FAILED", message }` |

Order: `start` → `status(classifying)` → [`status(retrieving)`] → `status(generating)` → `thinking`* / `text`* → `done` | `error`.

The title in `start` is the conversation's existing title, or null for a new chat. The judge may create one, and it then arrives in `status(generating)`.

## 6. Controller: new route in `src/ai/ai.controller.ts` (existing `chat` untouched)
```ts
@Authenticate({ verifiedEmail: true })
@Post("stream")
async chatStream(@Body(new ZodValidationPipe(chatBodySchema)) body, @CurrentUser() user,
                 @Query("conversationId") conversationId: string | undefined, @Res() res: Response) {
  const ctx = await this.aiService.prepareStream(body.prompt, user.id, conversationId); // throws → normal 4xx
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });
  res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
                        Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  try {
    for await (const ev of this.aiService.streamAnswer(ctx, abort.signal)) {
      if (abort.signal.aborted) continue;
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    }
  } catch (err) {
    if (!abort.signal.aborted) { logger.error(err); res.write(`event: error\ndata: {"message":"Generation failed"}\n\n`); }
  } finally { res.end(); }
}
```
- `@Res()` uses Express's `Response` type (`import type { Response } from "express"`).
- Only auth (from `@Authenticate`), body validation, 401/400/403 from `prepareStream`, and 500s from those quick DB queries are returned as HTTP statuses. Everything else arrives as an `error` event.
- **Client impact:** a quota limit on this route is an `error` event, not an HTTP 429.

## Time to first byte (TTFB)
The first version ran history, judge, usage, title, RAG and the USER insert inside `prepareStream`, all **before** `flushHeaders()`. The client got nothing, not even `start`, until all of that finished, and then waited for the model's thinking on top. Tokens then arrived in a fast burst, which looked like buffering.

Investigation showed **nothing on our side buffers the SSE output**:
- `main.ts` and `app.module.ts` have no compression, middleware or global interceptors.
- The only global interceptor, `AuthenticationScopeInterceptor` from `@nestjs/authentication`, wraps the handler in an auth scope and never touches `res.write` or `res.end`.
- The Gemini SDK reads the SSE body incrementally.

Note: VS Code REST Client and plain POST requests in Insomnia buffer the whole response. Only `curl -N` or a `fetch` reader shows real streaming.

Changes that fixed it:
1. **Headers and `start` go out right after the quick checks.** The judge, usage, title, RAG and USER insert moved from `prepareStream` into `streamAnswer`.
2. **`status` events** show progress (`classifying`, `retrieving`, `generating`), so the client has something to render while the judge runs.
3. **NORMAL streams with `ThinkingLevel.LOW`** instead of the model default.

Measured after the fix, with `curl -N` and a CHEAP answer about DHCP:

| Step | Time since request |
|---|---|
| `start` + `status(classifying)` | ~0 s |
| `status(generating)` (judge done) | ~1.2 s |
| first `text` (Gemini's first token) | ~4.0 s (~2.8 s after generating) |
| following `text` chunks | every ~60 ms |

The remaining wait before the first token is the judge call (~1.2 s) plus Gemini's own first-token latency (~2.8 s). Possible next steps (not done):
- Set `includeThoughts: false` on the judge. Its thoughts are never used.
- Run a speculative RAG search in parallel with the judge.
- Fetch the history in parallel with other setup work.

The temporary `[STREAM TIMING]` logs used for these measurements have been removed.

## Files
- New: `src/ai/models/gemini-stream.ts`, `src/ai/dto/chat-stream-event.ts`, `specs/stream-generation.md`
- Modified (additions only): `src/ai/ai-provider.type.ts`, `src/ai/models/{cheap,normal,expensive}.model.ts`, `src/ai/ai.service.ts`, `src/ai/ai.controller.ts`, `_test.http` (a `CHAT STREAM (SSE)` request)
- Unchanged: `ai.factory.ts`, `ai.module.ts`, `judge-model.ts`, every `generate()`, `AiService.chat()`

## Verification
The test suite is skipped: the auth specs are broken, and the user asked not to run tests for this work.
1. `npx tsc --noEmit` and `npm run lint` must add no new errors. 3 tsc errors in the auth specs already exist.
2. Manual check, with `npm run start:dev` running. Use Git Bash; the loop timestamps each line as it arrives:
   ```bash
   curl -sN -X POST "http://localhost:3000/ai/chat/stream?conversationId=<uuid>" \
     -H "Content-Type: application/json" -H "Cookie: __Host-sid=<sid>" \
     -d '{"prompt":"Explique DHCP em detalhes"}' \
     | while IFS= read -r l; do echo "$(date +%T.%3N) $l"; done
   ```
   Expect `start` immediately, `status` events, then incremental `text` events (plus `thinking` for NORMAL or EXPENSIVE), then `done`. Then check that the `messages` table has the USER row and the IA row with `status = COMPLETED`.
3. Disconnect check: press Ctrl+C mid-stream. The server log shows the abort, and the IA row holds the partial text with `status = FAILED` and 0 tokens.
4. Error checks: an invalid `conversationId` returns HTTP 400 (not SSE), and another user's conversation returns 403. An exhausted advanced quota yields an `error` event with `code: ADVANCED_MESSAGES`.
5. Regression check: `POST /ai/chat` still returns the plain full text.
