# Unit Testing Spec (NestJS + Jest)

This document instructs the coding agent on how to write **unit tests** for this NestJS backend. Follow it strictly whenever asked to create or update tests.

## 1. Scope

- Write **unit tests only**.
- **Do NOT write integration or e2e tests** for now. This means:
  - No `supertest`, no booting the full app (`app.init()`), no HTTP requests.
  - No real database, cache, queue, filesystem or network access.
  - No importing real modules that wire up infrastructure (e.g. `TypeOrmModule`, `PrismaModule`, `ConfigModule.forRoot()`).
- One spec file tests **one class**. Everything the class depends on is mocked.

## 2. Tooling

- Test runner: **Jest** (with `ts-jest`).
- Use `@nestjs/testing` (`Test.createTestingModule`) to build the unit under test.
- Do not add new testing libraries without asking. Use only what is already in `package.json`.

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
import { UsersService } from './users.service';
import { UsersRepository } from './users.repository';

describe('UsersService', () => {
  let service: UsersService;
  let repository: jest.Mocked<UsersRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: UsersRepository,
          useValue: {
            findById: jest.fn(),
            save: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(UsersService);
    repository = module.get(UsersRepository);
  });

  afterEach(() => {
    jest.clearAllMocks();
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
- Use `Test.createTestingModule` with providers `{ provide: Token, useValue: { method: jest.fn() } }` for every dependency.
- Rebuild the module in `beforeEach` so each test is isolated.
- Call `jest.clearAllMocks()` in `afterEach` (or rely on `clearMocks: true` in the Jest config if it is already set).
- Follow **Arrange / Act / Assert**, separated by blank lines. Comments marking the phases are optional.
- Type mocks as `jest.Mocked<T>` to keep type safety.
- Prefer one logical behavior per `it`. A test name must describe behavior: `should <expected result> when <condition>`.

## 6. Mocking rules

- Mock **every** collaborator: repositories, other services, HTTP clients, loggers, config services, queues, event emitters, etc.
- Mock only the methods the class under test actually uses.
- Never call the real implementation of a dependency.
- For time, randomness and UUIDs, make them deterministic:
  - `jest.useFakeTimers().setSystemTime(...)` and restore with `jest.useRealTimers()`.
  - `jest.spyOn(...)` for `Math.random`, `crypto.randomUUID`, etc. Restore after the test.
- For `ConfigService`, mock `get`/`getOrThrow` with the values the test needs.
- Do not mock the class under test itself, and do not mock pure helper functions that are part of the class's own logic.
- Do not use `any` to silence type errors in mocks. Use `Partial<T>`, `jest.Mocked<T>` or a typed factory.

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
- Controllers: test that they delegate to the service with the right arguments and return/propagate its result. Do **not** test HTTP behavior, routing or serialization (that is integration territory).
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

- Real I/O of any kind (DB, HTTP, filesystem, Redis, queues).
- `setTimeout`/sleeps to wait for things. Use fake timers or awaited promises.
- Tests that depend on execution order or share mutable state between `it` blocks.
- `it.only`, `describe.only`, `xit`, `it.skip` left in committed code.
- `console.log` in tests.
- Modifying the source file under test just to make it testable, unless asked. If the class is genuinely untestable (e.g. hard-coded `new` of a dependency), **stop and report it** instead of working around it.
- Copy-pasted tests with only the name changed. Use `it.each` / `describe.each` for tabular cases.

## 11. Workflow for the agent

1. Read the class under test and its direct dependencies' types/signatures.
2. List public methods and, for each one, every branch and error path.
3. Write the spec following sections 5-9.
4. Run only that spec: `npx jest path/to/file.spec.ts`.
5. Check coverage for that file: `npx jest path/to/file.spec.ts --coverage --collectCoverageFrom=path/to/file.ts`. Look at uncovered lines/branches and add tests for any that represent real behavior. There is no numeric threshold, but uncovered branches must be justified or covered.
6. Fix failures. If a test reveals what looks like a **bug in the source**, do not change the source silently: report it and either leave the test failing with a clear note or ask how to proceed.
7. Run the full unit suite (`npx jest`) to confirm nothing else broke.
8. Summarize: which file was tested, how many tests were added, which edge cases were covered, and anything that could not be covered and why.

## 12. Definition of done

- [ ] Spec file is next to the source file and named `*.spec.ts`.
- [ ] All dependencies mocked via `Test.createTestingModule`.
- [ ] Every public method has its own `describe`.
- [ ] Every branch, error path and edge case from section 7 is covered or explicitly justified as not applicable.
- [ ] No integration/e2e tests, no real I/O.
- [ ] Test names are in English and describe behavior.
- [ ] `npx jest <file>` passes, and the full suite still passes.
- [ ] No lint or type errors in the new spec.