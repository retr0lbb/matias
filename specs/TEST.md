# Unit Testing Spec (NestJS + Vitest)

This document instructs the coding agent on how to write **unit tests** for this NestJS backend. Follow it strictly whenever asked to create or update tests.

## 1. Scope

- Write **unit tests only**.
- **Only test the class(es)/file(s) explicitly requested.** Do not add, extend or "helpfully" fix tests for other classes (controllers, modules, other services) unless the user asks for them. If a related spec is broken and blocks the suite, **report it and ask** before touching it.
- **Do NOT write integration or e2e tests** for now. This means:
  - No `supertest`, no booting the full app (`app.init()`), no HTTP requests.
  - No real database, cache, queue, filesystem or network access.
  - No importing real modules that wire up infrastructure (e.g. `TypeOrmModule`, `PrismaModule`, `DrizzleModule`, `ConfigModule.forRoot()`).
- One spec file tests **one class**. Everything the class depends on is mocked.

## 2. Tooling

- Test runner: **Vitest** (already configured in `vitest.config.ts`, `globals: true`).
- Mocking API: **`vi`** (`vi.fn()`, `vi.mocked()`, `vi.spyOn()`, `vi.clearAllMocks()`, `vi.useFakeTimers()`). **Do not use the `jest.*` API** — this project does not use Jest.
- Use `@nestjs/testing` (`Test.createTestingModule`) to build the unit under test.
- Do not add new testing libraries without asking. Use only what is already in `package.json`.
- Globals are enabled: `describe`, `it`, `expect`, `beforeEach`, `afterEach` and `vi` are available without imports. Import types (`Mock`, `Mocked`, `MockedFunction`) with `import type { ... } from 'vitest'`.

## 3. File location and naming

- Place the spec **next to the file under test**.
- Name it `<original-file-name>.spec.ts`.

```
src/users/users.service.ts
src/users/users.service.spec.ts
```

## 4. Language

- All test names (`describe`, `it`), comments and descriptions are written in **English**.

## 5. Structure of a spec file

Use this structure:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import type { MockedFunction } from 'vitest';
import { UsersService } from './users.service.js';
import { UsersRepository } from './users.repository.js';

const createRepositoryMock = () => ({
  findById: vi.fn() as unknown as MockedFunction<UsersRepository['findById']>,
  save: vi.fn() as unknown as MockedFunction<UsersRepository['save']>,
});

describe('UsersService', () => {
  let service: UsersService;
  let repository: ReturnType<typeof createRepositoryMock>;

  beforeEach(async () => {
    repository = createRepositoryMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: UsersRepository, useValue: repository },
      ],
    }).compile();

    service = module.get(UsersService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('findById', () => {
    it('should return the user when it exists', async () => {
      // Arrange
      repository.findById.mockResolvedValue(user);

      // Act
      const result = await service.findById('id');

      // Assert
      expect(result).toEqual(user);
      expect(repository.findById).toHaveBeenCalledWith('id');
    });

    it('should throw NotFoundException when the user does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findById('id')).rejects.toThrow(NotFoundException);
    });
  });
});
```

Rules:

- One top-level `describe` named after the class.
- One nested `describe` per **public method**.
- Use `Test.createTestingModule` with providers `{ provide: Token, useValue: <mock> }` for every dependency.
- Rebuild the module (and the mocks) in `beforeEach` so each test is isolated.
- Call `vi.clearAllMocks()` in `afterEach`.
- Follow **Arrange / Act / Assert**, separated by blank lines. Comments marking the phases are optional.
- Type mocks with `vitest` types (`Mock`, `Mocked<T>`, `MockedFunction<T>`). A typed factory that returns `MockedFunction<Owner['method']>` is preferred: it keeps type safety **and** avoids the `typescript(unbound-method)` lint warning that `Mocked<T>` on a class reference produces.
- Import local modules with the `.js` extension (the project uses `module: nodenext`).
- Prefer one logical behavior per `it`. A test name must describe behavior: `should <expected result> when <condition>`.

## 6. Mocking rules

- Mock **every** collaborator: repositories, other services, HTTP clients, loggers, config services, queues, event emitters, database clients, etc.
- Mock only the methods the class under test actually uses.
- Never call the real implementation of a dependency.
- For chained builders (e.g. Drizzle/query builders), mock the chain explicitly and make the awaitable end resolve:
  ```ts
  const db = { select: vi.fn(), from: vi.fn(), where: vi.fn() } as unknown as DbMock;
  db.select.mockReturnValue(db);
  db.from.mockReturnValue(db);
  db.where.mockResolvedValue([]);
  ```
  For Nest-injected non-class tokens (e.g. `getDrizzleToken()` from `@nestjs/drizzle`), use the exported token function as the `provide` value.
- For time, randomness and UUIDs, make them deterministic:
  - `vi.useFakeTimers()` + `vi.setSystemTime(...)` and restore with `vi.useRealTimers()`.
  - `vi.spyOn(...)` for `Math.random`, `crypto.randomUUID`, etc. Restore with `vi.restoreAllMocks()`.
- For `ConfigService`, mock `get`/`getOrThrow` with the values the test needs.
- Do not mock the class under test itself, and do not mock pure helper functions that are part of the class's own logic.
- Do not use `any` to silence type errors in mocks. Use `Partial<T>`, `Mocked<T>`, `MockedFunction<T>` or a typed factory.

## 7. What to cover (edge cases checklist)

The goal is to cover **all relevant edge cases of the class**. Before writing tests, read the class and list every public method, then every branch inside each one. For each method, go through this checklist and write a test for every item that applies:

**Control flow**
- Happy path.
- Every `if` / `else` / `switch` / ternary / `??` / `?.` / `&&` / `||` branch.
- Early returns and guard clauses.
- Loops with zero, one and many items.

**Inputs**
- `null` and `undefined` (when the type allows them or the code does not guard against them).
- Empty string, empty array, empty object.
- Boundary values: `0`, negative numbers, `1`, max/min allowed, off-by-one on limits and pagination.
- Duplicate items, unsorted items, very large collections when relevant.
- Invalid or unexpected formats when the class parses or validates data (dates, emails, IDs, enums).

**Dependencies**
- Dependency returns a value / `null` / empty result.
- Dependency **throws** or rejects: verify the error is propagated, wrapped or handled as the code intends.
- Dependency is called with the exact expected arguments (`toHaveBeenCalledWith`), the expected number of times (`toHaveBeenCalledTimes`), and **not called** when it should not be (`not.toHaveBeenCalled`).
- Order of calls when order matters (`mock.invocationCallOrder` or sequential assertions).

**Errors**
- Every `throw` in the class: assert the **exception type** and, when meaningful, the message or payload.
- Every `catch` block: assert what is returned, logged or rethrown.
- Async: use `await expect(...).rejects.toThrow(...)`. Never leave a promise unawaited.

**State and side effects**
- Objects passed in are not mutated unexpectedly (or are mutated when that is the intent).
- Returned objects have the right shape and values (`toEqual` / `toMatchObject`), including fields that must be **absent** (e.g. password hash never returned).
- Events emitted, logs written and cache invalidations triggered, via the mocked collaborator.

**Nest-specific**
- Guards, pipes, interceptors and filters: test their own logic in isolation (e.g. call `canActivate` with a mocked `ExecutionContext`).
- Controllers (only when explicitly in scope): test that they delegate to the service with the right arguments and return/propagate its result. Do **not** test HTTP behavior, routing or serialization (that is integration territory).
- Decorator metadata, DI wiring and module imports are **out of scope** for unit tests.

## 8. Assertions

- Be specific: prefer `toEqual`, `toBe`, `toHaveBeenCalledWith` and `rejects.toThrow(SpecificError)` over loose checks like `toBeTruthy()`.
- Every test must contain at least one meaningful assertion.
- Do not assert on implementation details that would break on a harmless refactor (e.g. private method calls). Test through the public API.
- Do not use snapshot tests unless explicitly asked.

## 9. Test data

- Create small typed factory functions or constants at the top of the spec (e.g. `buildUser(overrides?: Partial<User>)`).
- Use clearly fake data. Never use real personal data, secrets or production IDs.
- Keep data minimal: only set the fields the test cares about.

## 10. Things to avoid

- Writing tests for classes the user did not ask for.
- Real I/O of any kind (DB, HTTP, filesystem, Redis, queues).
- The `jest.*` API (use `vi.*`).
- `setTimeout`/sleeps to wait for things. Use fake timers or awaited promises.
- Tests that depend on execution order or share mutable state between `it` blocks.
- `it.only`, `describe.only`, `xit`, `it.skip` left in committed code.
- `console.log` in tests.
- Modifying the source file under test just to make it testable, unless asked. If the class is genuinely untestable (e.g. hard-coded `new` of a dependency), **stop and report it** instead of working around it.
- Copy-pasted tests with only the name changed. Use `it.each` / `describe.each` for tabular cases.

## 11. Workflow for the agent

1. Confirm the exact class(es)/file(s) in scope. Only test those; do not expand the scope on your own.
2. Read the class under test and its direct dependencies' types/signatures.
3. List public methods and, for each one, every branch and error path.
4. Write the spec following sections 5-9.
5. Run only that spec: `npx vitest run path/to/file.spec.ts`.
6. Check coverage for that file: `npx vitest run path/to/file.spec.ts --coverage` (scope the report to the file under test if needed via `--coverage.include`). Look at uncovered lines/branches and add tests for any that represent real behavior. There is no numeric threshold, but uncovered branches must be justified or covered.
7. Fix failures. If a test reveals what looks like a **bug in the source**, do not change the source silently: report it and either leave the test failing with a clear note or ask how to proceed.
8. If a pre-existing spec fails for reasons unrelated to the requested work, **report it** and ask before fixing it.
9. Run the full unit suite (`npm test`) to confirm nothing else broke, and `npm run lint`.
10. Summarize: which file was tested, how many tests were added, which edge cases were covered, and anything that could not be covered and why.

## 12. Definition of done

- [ ] Only the requested class(es)/file(s) were tested.
- [ ] Spec file is next to the source file and named `*.spec.ts`.
- [ ] All dependencies mocked via `Test.createTestingModule`.
- [ ] Every public method has its own `describe`.
- [ ] Every branch, error path and edge case from section 7 is covered or explicitly justified as not applicable.
- [ ] No integration/e2e tests, no real I/O.
- [ ] Vitest `vi.*` API is used (no `jest.*`).
- [ ] Test names are in English and describe behavior.
- [ ] `npx vitest run <file>` passes, and the full suite (`npm test`) still passes.
- [ ] No lint (`npm run lint`) or type (`npx tsc --noEmit`) errors in the new spec.
