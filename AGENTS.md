# AGENTS.md — Testing

Rules for writing and changing tests in this repository.

## Golden rule: stay in scope

- **Test only what the user explicitly asks for.** If asked to test `X`, write/modify tests for `X` and nothing else.
- Do **not** add, extend, refactor or "fix while you're there" spec files for other classes (controllers, modules, guards, other services).
- If an unrelated spec is broken and blocks the full suite, **report it and ask** before touching it. Never silently fix out-of-scope tests or source.
- If a test reveals what looks like a **bug in the source**, do not change the source silently — report it and ask how to proceed.

## Use Vitest, not Jest

- This project runs **Vitest** (`vitest.config.ts`, `globals: true`). Do **not** use the `jest.*` API.
- Use the `vi.*` API: `vi.fn()`, `vi.mocked()`, `vi.spyOn()`, `vi.clearAllMocks()`, `vi.useFakeTimers()`, `vi.restoreAllMocks()`.
- Test globals (`describe`, `it`, `expect`, `beforeEach`, `afterEach`, `vi`) are available without imports. Import only **types** from `vitest` (`import type { Mock, Mocked, MockedFunction } from 'vitest'`).
- Full testing conventions live in [`specs/TEST.md`](specs/TEST.md). Follow it for all test work.

## Required checks before saying "done"

Run, and make sure they pass:

```bash
npx vitest run <path/to/file.spec.ts>   # the spec you wrote
npm test                                 # full unit suite
npm run lint                             # oxlint (type-aware)
npx tsc --noEmit                         # type check
```

For coverage of the file under test:

```bash
npx vitest run <path/to/file.spec.ts> --coverage
```

## Test-writing essentials

- Unit tests only: no real DB/HTTP/filesystem/queue access, no `supertest`, no `app.init()`.
- One spec tests one class; mock every collaborator via `Test.createTestingModule`.
- Spec files live next to the source and are named `*.spec.ts`.
- Structure: one top-level `describe` = class, one nested `describe` per public method, Arrange/Act/Assert, `vi.clearAllMocks()` in `afterEach`.
- Prefer typed mock factories (`MockedFunction<Owner['method']>`) over `any`, and avoid `Mocked<T>` class references that trip the `typescript(unbound-method)` lint rule.
- Cover happy paths, every branch, guard clauses, empty/boundary inputs, dependency throw/reject paths, and every `throw`/`catch`.
- Test names in English, in the form `should <expected result> when <condition>`.
- Never commit `it.only`/`describe.only`/`it.skip`, `console.log`, or snapshot tests (unless asked).
