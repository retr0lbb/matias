# Google Classroom tools

MATIAS can read a teacher's Google Classroom classes and create homework there from the chat. Code lives in `src/classroom`; the AI side is in `src/ai/models/gemini-tools.ts` and `AiService.resolveTools`.

## Before it works (to do, as of 2026-11-22)

The code is done and unit tested, but it has not run against real Google yet. To turn it on:

- [ ] **Migration:** run `npm run db:migrate` to create the `google_integrations` table (`drizzle/20261122050422_google_integrations`).
- [ ] **Plan flag:** set `classroomTools: true` by hand in `plans.limits` on the paid plans. It defaults to `false`, so even paid users get no tools until this is done.
- [ ] **Env:** add `GOOGLE_TOKEN_ENC_KEY` (`openssl rand -base64 32`). The app does not start without it, and changing it later forces every teacher to reconnect.
- [ ] **Google Cloud:**
  - [ ] Enable the Classroom API and the Drive API.
  - [ ] Add the scopes listed below to the OAuth consent screen.
  - [ ] Register the second redirect URI, `…/auth/oidc/google-classroom/callback`. An existing `GOOGLE_REDIRECT_URL` ending in `/google/callback` is converted automatically.
- [ ] **Test users:** the Classroom scopes are sensitive, so until Google verifies the consent screen only test users (up to 100) can connect. Add your test teacher account.
- [ ] **Manual end-to-end test:**
  1. Connect via `/auth/oidc/google-classroom/connect`, then check `GET /classroom/status`.
  2. On a paid plan, ask "quais são minhas turmas?" in the chat. `tool` SSE events should stream and the classes should be listed.
  3. Generate an assessment, then ask to post it as homework. A draft with the PDF attached should appear in Classroom.
  4. On FREE, the answer should explain the upgrade.
  5. Disconnect, and the tools should answer `NOT_CONNECTED`.
- [ ] **Optional:** write an `AiService` spec. The `resolveTools` wiring has no unit tests yet.

## Connecting ("Connect Classroom")

Sign-in and Classroom access are separate. Any signed-in user (LOCAL or GOOGLE) can connect any Google account, for example a school account:

1. The frontend sends the browser to `GET /auth/oidc/google-classroom/connect?redirectTo=/settings`.
2. `@nestjs/authentication` runs a **link** flow on the `google-classroom` provider (`src/app.module.ts`). It requires a signed-in session and refuses cross-site starts. It asks for:
   - `classroom.courses.readonly`
   - `classroom.rosters.readonly` (student names; emails need `classroom.profile.emails`, which we do **not** ask for)
   - `classroom.coursework.students` (create coursework)
   - `drive.file` (only files the app itself creates)
   - `access_type=offline` and `prompt=consent`, so Google always returns a refresh token.
3. On the callback, `AccountLinker` calls `GoogleIntegrationService.save`. That stores the tokens in `google_integrations`, AES-256-GCM encrypted with `GOOGLE_TOKEN_ENC_KEY`.
   - If the teacher unchecked a permission, the callback answers `400 MISSING_SCOPES`.
   - The `google-classroom` provider can never be used to sign in.

Other endpoints:
- `GET /classroom/status` returns `{ connected, email, connectedAt }`.
- `DELETE /classroom/connection` revokes the token at Google (best effort) and deletes the row.

Access tokens are cached and refreshed one minute before they expire. If Google answers `invalid_grant` (the access was revoked, or the token expired after 6 months unused), the row gets `revoked_at` and the tools answer `NOT_CONNECTED` until the teacher connects again.

## When the tools run

1. The judge picks tools from `CLASSROOM_TOOL_NAMES` (`src/classroom/classroom-tool-names.ts`).
2. `AiService.resolveTools` offers them only when all of these hold:
   - the plan has `classroomTools: true` (in `plans.limits`; it defaults to `false`, so **set it by hand on the paid plans**)
   - the model is not CHEAP
   - Classroom is connected
3. Otherwise the prompt tells the model why (`PLAN`, `CHEAP_MODEL` or `NOT_CONNECTED`), so it explains instead of pretending.
4. `streamWithTools` runs the Gemini function-calling loop: at most 4 rounds with tools, then one round without, with tokens summed across rounds. The SSE stream emits `event: tool` with `{ name, status: "running" | "done" | "error" }`.

## Tools

| Tool | Returns |
|---|---|
| `classroom_list_courses` | Active classes the user teaches: id, name, section, room, link |
| `classroom_get_course` | One class plus `studentCount` |
| `classroom_list_students` | `{ count, students: ["Ana S.", ...] }` |
| `classroom_list_coursework` | Latest 20 assignments (published and drafts) |
| `classroom_create_assignment` | Creates a **DRAFT** assignment. Optional `assessmentId` attaches a generated assessment as a PDF uploaded to the teacher's Drive. Due date and time are São Paulo time. |

Errors come back to the model as `{ error: "NOT_CONNECTED" | "PERMISSION_DENIED" | "NOT_FOUND" | "INVALID_ARGS" | "UNAVAILABLE" | "UNKNOWN_TOOL" }`.

The model learns which assessments it can attach from the system prompt, which lists the id and title of the assessments of the current conversation.

## Student privacy

- Roster requests use a field mask (`students(profile(name))`), so emails, ids and photos never reach our server.
- Names are cut to the given name plus the last initial before going to Gemini.
- Tool arguments and results are not logged or stored. Message metadata keeps only `tools: [{ name, ok, latencyMs }]`, and the Google client logs only the status and URL path.

## Setup

- Google Cloud project: enable the Classroom API and the Drive API, and add the scopes above to the OAuth consent screen.
- Register both redirect URIs: `.../auth/oidc/google/callback` and `.../auth/oidc/google-classroom/callback`. `GOOGLE_REDIRECT_URL` may contain `:provider`. An older value ending in `/google/callback` is converted automatically.
- `GOOGLE_TOKEN_ENC_KEY`: `openssl rand -base64 32`. Changing it makes every stored connection unreadable, so teachers must reconnect.
- Run the `google_integrations` migration (`npm run db:migrate`).
- The Classroom scopes are **sensitive**: until Google verifies the consent screen, only test users (up to 100) can connect.

## Known limits

- `list_courses` returns the first 50 active classes, and `list_coursework` the latest 20.
- There is no unit spec for `AiService` yet, so the `resolveTools` wiring is covered only by the manual test.
