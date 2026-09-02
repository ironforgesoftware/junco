# Contributing to Junco

---

## Dev setup

**Requirements:** Node ≥ 22.19, npm. `.nvmrc` pins the exact engines floor (`nvm use` picks it up).

```bash
npm install          # install dependencies
npm run build        # tsc -p tsconfig.json → dist/
npm test             # run the full vitest suite (~4,600 tests, ~40 s)
npm run test:e2e     # end-to-end: the built CLI in a sandboxed HOME against a scripted model stub (needs dist/)
npm run test:watch   # re-run on file changes
```

The CLI entry point after building is `dist/cli.js`. You can run it directly with `node dist/cli.js <subcommand>` or via the `junco` bin alias if you have linked the package.

### Quality gate

Before opening a PR, run the full gate. It is exactly what CI (`.github/workflows/quality-gate.yml`) runs on every PR, and the aggregate `quality-gate` check is required to merge:

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build && npm test && npm run test:e2e
```

`npm run lint` and `npm run typecheck` cover `tests/` as well as `src/` (via `tsconfig.eslint.json`) — vitest does not type-check, so a type error in a test only surfaces here.

---

## Project conventions

### TypeScript

- **NodeNext module resolution** — import siblings with a `.js` specifier even though the source file is `.ts`. Example:

  ```ts
  import { claim } from "./queue.js"; // ✓ correct
  import { claim } from "./queue"; // ✗ breaks at runtime
  ```

- **Strict mode** is on. Do not disable individual strict checks.
- **Function size** — `max-lines-per-function` caps one function in `src/` at 400 lines of code (blank lines and comments do not count). The handful of functions that predate the rule are pinned at their current size in `eslint.config.js`, each with the issue that will retire it; that table is only allowed to shrink, so a new function over the ceiling gets split rather than an entry.
- Config is parsed and validated with **zod**. All config types flow from `configSchema.ts` / `types.ts` (re-exported through `config.ts`); do not add raw `any` casts to handle config fields.

### Dependencies

Dependencies are **exact-pinned** — `package.json` carries no `^` or `~` ranges. Add one with `npm install --save-exact <pkg>` (add `--save-dev` for tooling) so the lockfile and the manifest agree on a single version.

### Dependency injection for testability

Unit tests must not touch the real network, real model, filesystem I/O outside a temp dir, or real timers. All external dependencies (the Pi session factory, `fetch`, the clock, `gh`, etc.) are passed in as arguments so tests can substitute fakes. Follow the same pattern when adding new collaborators.

The PR-flow integration tests use a **real local git harness** (bare remote + clone) and a fake `gh` binary — the agent itself is still faked.

---

## How to make common changes

### Add a config knob

1. Add the field to the zod schema in `configSchema.ts`.
2. Add the corresponding type to the `Config` interface in `types.ts`.
3. Map the parsed value inside `assembleConfig` in `configAssemble.ts`.
4. Update any test fixtures that construct a `Config` object directly — the TypeScript compiler will flag them as incomplete.

### Add a loop guard

1. Implement the guard class in `agent/guards.ts` following the pattern of the existing four guards (`RepetitionGuard`, `ToolCallLoopGuard`, `ToolErrorLoopGuard`, `OutputBudgetGuard`).
2. Wire it into `agent/guardManager.ts` so it is subscribed to the event stream.
3. If the guard needs a new nudge message, add a template to `agent/nudges.ts`.
4. Update `agent/supervisor.ts` if the new guard requires a different nudge/kill decision.

### Extend the ticket frontmatter

The frontmatter schema in `ticketSchema.ts` is the **stable public contract** — changing it is a breaking change for any tool that generates or validates tickets. If you add, rename, or remove a field:

1. Update `ticketSchema.ts`.
2. Run `junco schema` to verify the emitted JSON Schema reflects your change.
3. Update `ticket.ts` if parse logic changes.
4. Update any test fixtures that construct ticket objects.
5. Document the new field in [`docs/tickets.md` § Key frontmatter fields](docs/tickets.md#key-frontmatter-fields).

### Add a CLI subcommand

`cli.ts` is the entrypoint; all subcommands are registered there. The `run(argv, deps)` function is the testable surface — new subcommands should accept their dependencies via `deps` so they can be exercised in unit tests without side effects.

---

## Testing expectations

- Test files live under `tests/` and mirror the `src/` layout (e.g. `src/queue.ts` → `tests/queue.test.ts`).
- Use **vitest**. Run the full [quality gate](#quality-gate) before submitting a PR; the suite must be green.
- Unit tests: inject fakes for all I/O. No real model calls, no real HTTP, no real timers.
- Integration tests (PR flow): use the real git harness pattern already in the suite; do not introduce real network calls.
- When adding a module, add a corresponding test file that covers the public surface.

---

## Commit and PR policy

- Branch `feat/<topic>` off `main` (`fix/`, `docs/`, `chore/` … for the other commit types); keep the suite green at every commit.
- Use **conventional commit** messages: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, etc.
- Keep the subject line under 72 characters; add a body if the why is non-obvious.
- **No AI attribution** — do not add `Co-Authored-By:` trailers referencing AI tools, and do not include "Generated with …" lines in commit messages or PR descriptions.
- PR descriptions should explain the motivation and summarize what changed; link to the relevant ticket if one exists.

---

## Provenance

The implementation in `src/` was ported from an earlier Python prototype, which has since been removed. Some modules carry `// Port of worker.py …` comments that reference that original as provenance for parity-sensitive logic (loop-guard thresholds, the critic prompt, the PR-flow phase order). Those references are historical — the Python files are no longer in the tree. All work goes in `src/` (TypeScript).
