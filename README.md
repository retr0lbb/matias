# MATIAS

MATIAS is a NestJS API that helps teachers with AI. It offers:

- a chat backed by Gemini
- search over documents the teacher uploads (RAG)
- assessments (exams and worksheets) the AI generates and the teacher can edit
- paid plans with per-cycle limits, billed through Asaas
- Google Classroom tools inside the chat

## Stack

| Part      | What it uses                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------ |
| Framework | NestJS 12 (ESM) with Express                                                                     |
| Database  | PostgreSQL 16 with pgvector, through Drizzle ORM (`drizzle/` holds the migrations)               |
| Auth      | `@nestjs/authentication`: session cookie, email and password, Google OIDC, email verification    |
| AI        | Gemini (`@google/genai`), for chat, embeddings and documents                                     |
| Documents | Generated from the chat as validated JSON; `pdf-parse` and `mammoth` read uploads; Playwright renders PDFs; `docx` builds Word files |
| Payments  | Asaas (PIX and credit card), with webhooks and two reconciliation cron jobs                      |
| Email     | `@nestjs/mail`, sent through Resend, or written to the log when `RESEND_API_KEY` is not set      |
| Tests     | Vitest; see [`AGENTS.md`](AGENTS.md) and [`specs/TEST.md`](specs/TEST.md)                        |

## Getting started

```bash
pnpm install
docker compose up -d          # Postgres + pgvector on localhost:5432 (user/password: docker, db: matias)
pnpm run db:migrate           # apply the Drizzle migrations
pnpm run start:dev            # http://localhost:3000
```

### Environment variables

| Variable                       | Required | What it is for                                                                                                                         |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                 | yes      | Postgres connection string                                                                                                             |
| `GEMINI_API_KEY`               | yes      | Gemini (chat, embeddings, documents)                                                                                                   |
| `GOOGLE_CLIENT_ID`             | yes      | Google OAuth web client, shared by sign-in and Classroom                                                                               |
| `GOOGLE_CLIENT_SECRET`         | yes      | Secret of that same client                                                                                                             |
| `GOOGLE_REDIRECT_URL`          | yes      | OIDC callback, e.g. `http://localhost:3000/auth/oidc/:provider/callback`. A value ending in `/google/callback` is converted automatically |
| `GOOGLE_TOKEN_ENC_KEY`         | yes      | Encrypts stored Classroom tokens (`openssl rand -base64 32`). It stays on the server and is never sent to Google                     |
| `ASAAS_API_KEY`                | yes      | Asaas API key                                                                                                                          |
| `ASAAS_API_URL`                | no       | Asaas base URL (sandbox or production)                                                                                                 |
| `ASAAS_WEBHOOK_TOKEN`          | yes\*    | Must match the `asaas-access-token` header Asaas sends. \*Every webhook is refused without it                                         |
| `APP_URL`                      | no       | Frontend URL to return to after Google sign-in (defaults to `/me`)                                                                     |
| `EMAIL_FRONTEND_URL_REDIRECT`  | yes      | Frontend base URL for verification links (`<url>/verify-email`)                                                                        |
| `EMAIL_DOMAIN`                 | yes      | Sender address (`Contato <EMAIL_DOMAIN>`)                                                                                              |
| `RESEND_API_KEY`               | no       | Sends real email. Without it, emails are only written to the log                                                                       |
| `EMBEDDING_TOKENS_PER_MINUTE`  | no       | Rate limit for embedding calls                                                                                                         |
| `PORT`                         | no       | HTTP port (default `3000`)                                                                                                             |

### Scripts

| Script                                            | What it does                                         |
| ------------------------------------------------- | ---------------------------------------------------- |
| `start` / `start:dev` / `start:debug` / `start:prod` | Run the API                                       |
| `test` / `test:watch` / `test:cov` / `test:e2e`   | Vitest                                               |
| `lint`                                            | oxlint (type-aware)                                  |
| `db:generate` / `db:migrate` / `db:studio`        | Drizzle Kit                                          |
| `start:ngrok`                                     | Public tunnel, used to receive Asaas webhooks locally |

## Authentication model

The authentication guard is **global**: every route needs a signed-in session unless it is marked **Public** below. The session is a cookie, set by `/auth/login`, `/auth/register` or the Google callback. Sessions last at most 14 days and expire after 4 days without use.

The **Auth** column in the tables below uses these values:

- **Public**: no session needed.
- **Session**: any signed-in user.
- **Verified**: a signed-in user whose email is verified. Otherwise the answer is `403`.

On top of auth, many routes check the user's **plan** (`plans.limits`, see [`specs/plan-limits-model-selection.md`](specs/plan-limits-model-selection.md)). The plan errors are:

- `429`: the quota for the cycle is used up (`QuotaExceededException`).
- `413`: the file is too big for the plan, or storage is full.
- `403`: the plan does not include the feature or the thinking level (`PlanRestrictionException`).

## Endpoints

### Auth: `/auth`, `/me`

| Method | Path                                    | Auth    | Requires                                                         | Returns / notes                                                                                     |
| ------ | --------------------------------------- | ------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| POST   | `/auth/register`                        | Public  | Body `{ email, name, password }`                                 | The new user. Signs them in (sets the cookie) and sends the verification email                      |
| POST   | `/auth/login`                           | Public  | Body `{ email, password }`                                       | `{ mfaRequired }` and sets the session cookie. Wrong credentials give `401`                         |
| POST   | `/auth/logout`                          | Public  | —                                                                | `204`. Deletes this browser's session right away and clears the cookie. Safe to call with no or an expired session |
| POST   | `/auth/email/verify`                    | Public  | Body `{ token }` (from the email link)                           | `{ email, emailVerified: true }`. An invalid or expired token gives `400`                           |
| POST   | `/auth/email/verification`              | Session | —                                                                | `202`, and resends the verification email. Gives `409` if the email is already verified             |
| GET    | `/me`                                   | Session | —                                                                | The signed-in user                                                                                  |
| GET    | `/auth/oidc/google/login`               | Public  | Query `redirectTo?`                                              | Redirects to Google sign-in                                                                         |
| GET    | `/auth/oidc/google/callback`            | Public  | Google's query params                                            | Signs the user in, then redirects to `APP_URL`                                                      |
| GET    | `/auth/oidc/google-classroom/connect`   | Session | Query `redirectTo?`. Must start from the same site               | Redirects to Google to grant Classroom access (link only, it never signs anyone in)                 |
| GET    | `/auth/oidc/google-classroom/callback`  | Session | Google's query params                                            | Stores the encrypted tokens. Gives `400 MISSING_SCOPES` if a permission was unchecked               |

### AI chat: `/ai/chat`

| Method | Path              | Auth     | Requires                                                                                                                                           | Returns / notes                                                       |
| ------ | ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| POST   | `/ai/chat/stream` | Verified | Body `{ prompt, model?: "AUTO" \| "CHEAP" \| "NORMAL" \| "EXPENSIVE", thinkingLevel?: "DEFAULT" \| "HIGH" \| "ULTRA_HIGH" }`. Query `conversationId?` | Server-Sent Events (see below). Without `conversationId`, a new conversation is started. This is the only route that sends messages |
| GET    | `/ai/chat`        | Session  | Query `limit?` (1–100, default 30), `cursor?` (the previous page's `nextCursor`)                                                                    | `{ items: [{ id, title, createdAt, updatedAt }], nextCursor }`, most recently active first. `nextCursor` is `null` on the last page |
| GET    | `/ai/chat/:id`    | Session  | —                                                                                                                                                  | `{ id, title, createdAt, updatedAt, messages }`, messages oldest first (see below). `404` when the chat is missing or not yours |
| PATCH  | `/ai/chat/:id`    | Session  | Body `{ title }` (1–256 chars)                                                                                                                     | `{ id, title, createdAt, updatedAt }`. Does not move the chat in the list. `404` when missing or not yours |
| DELETE | `/ai/chat/:id`    | Session  | Query `deleteDocuments?=true` (or body `{ deleteDocuments: true }`) also deletes the documents made in the chat                                    | `204`. Its messages are deleted with it; files uploaded to it are kept. `404` when missing or not yours |

`updatedAt` is set when a chat is created and bumped on every new message (user and assistant), so the list order follows activity. Renaming does not bump it.

Pagination is keyset on `(updatedAt, id)`: keep calling with the last `nextCursor` until it is `null`. The cursor is opaque, so send it back as is; a malformed one gives `400`. A new chat started from the stream lands at the top, so refetch the first page after the `start` event.

A chat that is missing or belongs to someone else always gives `404` on these routes (never `403`), so they don't reveal that it exists. Sending a message to someone else's chat (`POST /ai/chat/stream?conversationId=…`) still gives `403`.

Each message in `GET /ai/chat/:id` (defined in `src/ai/dto/chat-detail.dto.ts`):

| Field         | Notes                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`, `role`, `text`, `createdAt` | `role` is `"user"` or `"assistant"`                                                       |
| `status`      | Assistant: `COMPLETED`, `FAILED` (client aborted) or `ERROR`; the text may be partial. `null` for user messages |
| `thinking`    | Assistant thinking text, or `null`                                                                            |
| `model`       | Assistant: `{ tier, selection, thinkingLevel, downgradedFrom, upgradedFrom }`, or `null`                       |
| `documents`   | Assistant: `[{ id, documentType, action, title, version }]` made or changed that turn (current title/version). Load from `/documents/:id` |
| `attachments` | User: `[{ id, name, type }]` files sent with the message (files uploaded before this change are not linked)   |
| `tools`       | Assistant: `[{ name, ok }]` Classroom tools called that turn                                                  |

Plan checks: messages per cycle for each model tier (`429`), and `thinkingLevel` up to the plan's `maxThinkingLevel` (`403`). With `AUTO`, a judge model picks the tier, and moves down a tier when the chosen one has no quota left.

**Documents are made in the chat.** The judge also reads each message for a document request: create, revise or redo one of the conversation's documents. Only the `assessment` type exists today. When it finds one, this happens:

1. **Header details:** for a new document whose school, teacher, subject or class the teacher hasn't given yet, MATIAS first asks for them. It asks once per conversation, and the teacher may skip.
2. **Model tier:** documents never run on CHEAP. A short or simple document uses NORMAL, and a long one, one built from uploaded files or one with entrance-exam questions uses EXPENSIVE. This applies over a manual pick too (`upgradedFrom` in the `generating` status), and a full tier moves up, never down to CHEAP.
3. **Context:** the document AI gets the message, the conversation and up to 10 excerpts from the files uploaded to the conversation. The header text is taken from what the teacher wrote.
4. **What it costs:** one chat message for the tier it ran on, plus a document credit, with the same rules as before (each credit includes `aiChangesPerDocument` AI changes).

A failed document spends no credit, and the answer explains what went wrong. A document made in a turn can be posted to Classroom in that same turn. See [`specs/document-generation-in-chat.md`](specs/document-generation-in-chat.md).

Stream events (`event: <type>`, defined in `src/ai/dto/chat-stream-event.ts`):

| Event      | Data                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------- |
| `start`    | `{ conversationId, title }`                                                                  |
| `status`   | `{ stage: "classifying" \| "retrieving" }`; `{ stage: "documenting" \| "document_failed", action, documentType }`; or `{ stage: "generating", model, selection, thinkingLevel, downgradedFrom?, upgradedFrom? }` |
| `document` | `{ id, documentType, action: "CREATE" \| "REVISE" \| "REGENERATE", title, version }`: a document was saved this turn. Load it from `/documents/:id` |
| `thinking` | `{ text }`                                                                                   |
| `text`     | `{ text }`, a chunk of the answer                                                            |
| `tool`     | `{ name, status: "running" \| "done" \| "error" }`, for Classroom tools                      |
| `done`     | `{ messageId, finishReason, usage }`                                                         |
| `error`    | A quota error body, or `{ code: "GENERATION_FAILED", message }`                              |

Errors found before the stream starts (auth, validation, plan) come back as normal HTTP status codes.

### RAG documents: `/rag/documents`

| Method | Path                  | Auth     | Requires                                                                                           | Returns / notes                                                      |
| ------ | --------------------- | -------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| POST   | `/rag/documents`      | Verified | `multipart/form-data` with field `file` (`.pdf` or `.docx`). `conversationId?` in the query or body | The document record. It is processed (parsed and embedded) in the background |
| POST   | `/rag/documents/batch`| Verified | `multipart/form-data` with field `files` (1 to 10 files, 20 MB each at most). `conversationId?`      | One record per file. Gives `400` when no file is sent                |
| GET    | `/rag/documents/:id`  | Verified | Path `id`                                                                                          | The processing status of the document                                |

Searching happens inside the chat (`POST /ai/chat/stream` with a `conversationId`); there is no search route. When the next user message in that conversation is saved, the files uploaded since the previous one are linked to it (`rag_documents.message_id`), and `GET /ai/chat/:id` shows them as that message's `attachments`. Plan checks: uploads per cycle (`429`), the plan's `maxFileBytes` (`413`, with a hard cap of 50 MB) and total storage (`413`). The file's real content is checked against its extension. See [`specs/rag-vector-database.md`](specs/rag-vector-database.md).

### Documents: `/documents`

Five types: `assessment`, `homework`, `lesson_plan`, `course_syllabus` and `group_work`. The judge picks the type from the chat message; the stored JSON carries it as `type`.

All routes need **Verified**. `:id` must be a UUID. These routes read, edit by hand and render; **creating and changing with AI happens only in the chat** (see above). A manual `PATCH` sends back the `version` the client last saw, and a stale `version` gives `409`.

| Method | Path                                         | Requires                                                                                    | Returns / notes                                                                 |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| GET    | `/documents/:id`                             | —                                                                                           | The document, with its `type`                                                   |
| PATCH  | `/documents/:id`                             | Body `{ version, ops: [...] }`                                                              | Manual edits with no AI and no credit. The ops are listed below                 |
| GET    | `/documents/:id/preview`                     | —                                                                                           | HTML for a sandboxed iframe (strict CSP, `no-store`)                            |
| GET    | `/documents/:id/pdf`                         | —                                                                                           | PDF download                                                                    |
| GET    | `/documents/:id/docx`                        | —                                                                                           | Word download                                                                   |
| GET    | `/documents/:id/answer-key`                  | —                                                                                           | Answer key (or *Guia de correção*) as a PDF. `400` for `lesson_plan` and `course_syllabus` |
| GET    | `/documents/:id/answer-key/preview`          | —                                                                                        | Answer key as HTML for the iframe                                               |

Patch ops: `set_title`, `set_instructions`, `update_section`, `insert_section`, `remove_section`, `replace_block`, `insert_block`, `remove_block`, `move_block`, `update_theme` and `update_header_fields`. A block kind the document's type doesn't allow gives `422`.

Plan checks, applied in the chat: documents per cycle (sent as an `error` event with the quota body; `0` turns the feature off), AI changes per document, and the thinking level. See [`specs/merge-documents-into-chat.md`](specs/merge-documents-into-chat.md), [`specs/document-generation-in-chat.md`](specs/document-generation-in-chat.md), [`specs/document-generation.md`](specs/document-generation.md), [`specs/document-blocks.md`](specs/document-blocks.md) and [`specs/document-credits.md`](specs/document-credits.md).

### Usage: `/usage`

| Method | Path     | Auth    | Requires | Returns                                                       |
| ------ | -------- | ------- | -------- | ------------------------------------------------------------- |
| GET    | `/usage` | Session | —        | The user's plan, its limits and what has been used this cycle |

### Subscriptions and payments: `/subscription`, `/webhooks/asaas`

| Method | Path                  | Auth                    | Requires                                                                                                                | Returns / notes                                                                                                |
| ------ | --------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| GET    | `/subscription/plans` | Public                  | —                                                                                                                       | The plans you can subscribe to                                                                                 |
| POST   | `/subscription`       | Verified                | Body `{ planId (uuid), paymentMethod: "PIX" \| "CREDIT_CARD", fullName (≥ 3 chars), cpf, discountCode? }`                | Creates the subscription on Asaas. Gives `409` if the user already has a pending or active one, and `400` for an invalid plan or promo code |
| POST   | `/webhooks/asaas`     | Public, checked by token | Header `asaas-access-token` equal to `ASAAS_WEBHOOK_TOKEN`                                                             | Always `200 { received: true }` for a valid token, and `401` without one. It activates, marks past due or ends the subscription, and records the payment |

Two cron jobs run in the São Paulo time zone:

- **Count Olaf** (every 30 minutes): syncs subscriptions and charges with Asaas, for the times a webhook never arrived.
- **Mr. Beliarge** (03:00 daily): ends subscriptions whose overdue charge is past the grace period.

See [`specs/payment-subscription-overview.md`](specs/payment-subscription-overview.md), [`specs/payment-asaas.md`](specs/payment-asaas.md) and [`specs/promo-code-discount.md`](specs/promo-code-discount.md).

### Google Classroom: `/classroom`

| Method | Path                    | Auth    | Requires | Returns / notes                                                                 |
| ------ | ----------------------- | ------- | -------- | ------------------------------------------------------------------------------- |
| GET    | `/classroom/status`     | Session | —        | `{ connected, email, connectedAt }`                                             |
| DELETE | `/classroom/connection` | Session | —        | `{ disconnected }`. Revokes the token at Google (best effort) and deletes it locally |

You connect with `GET /auth/oidc/google-classroom/connect` (listed under Auth). After that, the chat can list classes, students and coursework, and create **draft** assignments with an assessment attached as a PDF. This only works on plans with `classroomTools: true` (on any model tier). See [`specs/google-classroom.md`](specs/google-classroom.md).

## Specs

Each feature is described in more detail in `specs/`:

- `auth-storage.md`
- `stream-generation.md`
- `message-metadata.md`
- `plan-limits-model-selection.md`
- `rag-vector-database.md`
- `document-generation.md`, `document-blocks.md` and `document-credits.md`
- `payment-subscription-overview.md`, `payment-asaas.md` and `promo-code-discount.md`
- `google-classroom.md`
- `TEST.md`

# TODO

- [ ] integrate usage with new database limits by user plan
- [ ] refactor create plan function to use new queue and idempotency libs
- [ ] create a lot of unit and integrations tests on the payment module
- [ ] add cpf and full name collection on the pre-existing user

- [ ] create ophan management cron job
- [ ] create subscription overseeyer cron job
