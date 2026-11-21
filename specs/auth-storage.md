# Postgres storage for `@nestjs/authentication`

## Why

`@nestjs/authentication` keeps its state (sessions, logins in progress, email links) in stores. A
store nobody registers falls back to process memory. That is fine in development, but:

- **Production refuses to start.** With `NODE_ENV=production`, the module throws at startup while a
  store a configured feature uses has no source (`AuthenticationStorage`, `refusesInMemory()`).
  `allowInMemoryStorage: true` turns the check off, but does not fix what follows.
- **Every restart or deploy** logs every user out, cancels any Google login in progress and
  invalidates email verification links.
- **More than one process** (PM2 cluster, a second container) does not share sessions: requests
  hitting another process look signed out.

## What this app needs

The features configured in `src/app.module.ts` use three of the library's store contracts:

| Contract | Used by | Lifetime |
|---|---|---|
| `sessions` | `SessionAuth` (session cookie), Google sign-in (`SignInService`) | `absoluteTtl: 14d`, `idleTtl: 4d` |
| `oidcStates` | Google logins between `/login` and `/callback` | `transactionTtl`, default 10 min |
| `emailTokens` | email verification links | the library's default for the purpose |

MFA (`mfa`), refresh tokens (`refreshTokens`) and magic links (`magicLinks`) are not configured, so
they need no store. If one of those features is turned on later, its store must be added here first,
or production refuses to start.

## Tables (`src/db/schemas/auth.ts`)

### `auth_sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | SHA-256 of the cookie token, as the library hands it over. The token itself is never stored. |
| `user_id` | uuid, FK `users.id` on delete cascade | deleting a user ends their sessions |
| `created_at`, `expires_at`, `last_active_at` | timestamp | |
| `mfa` | text, nullable | `pending` / `verified`; unused while MFA is off |
| `metadata` | jsonb, nullable | app data (user agent, IP) for a future "your sessions" page |

Indexes: `user_id`, `expires_at`. The record's `extra` field is read along with a session and never
stored, as in the in-memory store.

### `auth_oidc_states`

| Column | Type | Notes |
|---|---|---|
| `state` | text PK | SHA-256 of the secret in the `__Host-oidc_tx` cookie |
| `provider` | text | `google` |
| `code_verifier` | text | PKCE |
| `nonce`, `redirect_to` | text, nullable | |
| `link` | jsonb, nullable | `{ userId, sessionId }` for an account-link flow |
| `created_at`, `expires_at` | timestamp | |

Index: `expires_at`.

### `auth_email_tokens`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | the library's token id (hashed by the library) |
| `purpose` | text | `email-verification` or `password-reset` |
| `user_id` | uuid, FK `users.id` on delete cascade | |
| `email` | varchar | the address the link was sent to |
| `fingerprint` | text, nullable | |
| `created_at`, `expires_at` | timestamp | |

Indexes: `(user_id, purpose)`, `expires_at`.

## Store (`src/auth/providers/drizzle-auth.store.ts`)

`DrizzleAuthStore` implements `SessionStore`, `OidcStateStore` and `EmailTokenStore`, and registers
itself from its constructor:

```ts
storage.registerSource({ sessions: this, oidcStates: this, emailTokens: this });
```

It is a provider of `AuthModule`. Its constructor runs before `AuthenticationModule.onModuleInit`
locks the registry; the startup log then names the store instead of `in-memory`.

Behaviour matches the library's in-memory stores:

| Method | Query |
|---|---|
| `getSession(id)` | select by id; `undefined` when missing. The library checks expiry. |
| `createSession(record)` | insert (without `extra`); deletes expired sessions first |
| `touchSession(id, at)` | update `last_active_at` only when `at` is later (it never goes back) |
| `deleteSession(id)` | delete; `true` when a row was deleted |
| `listUserSessions(userId)` / `deleteUserSessions(userId)` | by `user_id` |
| `saveOidcState(tx)` | deletes expired states, then inserts |
| `consumeOidcState(state)` | `DELETE … RETURNING`: one statement, so a login finishes at most once even under concurrency |
| `saveEmailToken(record)` | deletes expired tokens, then inserts |
| `consumeEmailToken(id, purpose)` | `DELETE … WHERE id AND purpose RETURNING`; a token of another purpose is neither returned nor deleted |
| `deleteUserEmailTokens(userId, purpose)` | by both |

`null` columns come back as missing fields, never `null`, as the library's records expect.

**Cleanup.** Expired rows are deleted when new ones of the same kind are written, which needs no
scheduler (the repo has none). A session that is never followed by another sign-in stays until the
next one; that is harmless, since the library refuses expired sessions on read.

## Not in scope

- Stores for MFA, refresh tokens and magic links (features off).
- A periodic cleanup job.

## Verification

1. `npx tsc --noEmit`, `npm run lint`.
2. `pnpm db:generate` and read the SQL; `pnpm db:migrate` on the target database.
3. The library's contract suite, `authenticationStoreContract()` from `@nestjs/authentication/testing`,
   run against a real Postgres.
4. Start the API: the storage log names `DrizzleAuthStore` for `sessions`, `oidcStates` and
   `emailTokens`. Sign in, restart the server, and `/me` still answers with the same cookie.
5. Start with `NODE_ENV=production`: the storage guard no longer refuses.
