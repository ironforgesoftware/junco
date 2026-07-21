# CI Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure CI into a single "Quality Gate" workflow whose one aggregate check ties every supported environment together, add the missing verification layers (tests typecheck, packaged-artifact smoke test), harden both workflows to current supply-chain best practice, modernize publishing to npm trusted publishing (OIDC), and enforce the gate with a branch ruleset on `main`.

**Architecture:** `test.yml` becomes `quality-gate.yml` with three job families: the existing 4-leg `test` matrix (ubuntu/macos × node 22.19.0/24, now including a `tsc --noEmit` pass over `tests/`), a new 2-leg `smoke` job that packs the npm tarball and drives the installed CLI in a sandboxed HOME, and an aggregate `gate` job (`needs: [test, smoke]`, `if: always()`) that fails unless every leg succeeded. `quality-gate` is the single status-check context a `main` branch ruleset requires. `publish.yml` drops the `NPM_TOKEN` secret in favor of OIDC trusted publishing and gains a tag↔version preflight plus the full lint/format/typecheck gate.

**Tech Stack:** GitHub Actions, npm trusted publishing (OIDC), TypeScript 5.9 (`tsc --noEmit`), vitest 2, GitHub branch rulesets via `gh api`, Dependabot (`github-actions` ecosystem).

## Global Constraints

- Branch: `feat/ci-quality-gate` off `main`, in this worktree (`/Users/alxedelweiss/junco/.claude/worktrees/ci_cd`). Never `cd` to the main checkout.
- Conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, optional scope). Suite green at every commit.
- **No AI attribution, ever.** After every commit run `git log --format='%B' -1` and verify there is no `Co-Authored-By: Claude` trailer or "Generated with Claude Code" line. Subagent-driven commits auto-append the trailer — `git commit --amend` it away.
- Actions are pinned to **full commit SHAs** with a `# vX.Y.Z` comment. Verified SHAs (resolved 2026-07-08):
  - `actions/checkout` v6.0.3 → `df4cb1c069e1874edd31b4311f1884172cec0e10`
  - `actions/setup-node` v6.4.0 → `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e`
- Do not touch live runtime state (`config.toml`, `tickets/`, `worktrees/`, `launchd.out/err`). All CLI smoke runs happen in a `mktemp -d` sandbox with `HOME` and `XDG_CONFIG_HOME` overridden.
- Prettier may reformat between read and edit: re-read before editing and run `npx prettier --write` on touched `.ts`/`.tsx` files before committing (YAML and `.sh` are not prettier-covered).
- The vitest exit-code trap: never pipe test output through a filter. Capture it: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"`.
- **Release HOLD still applies.** Nothing in this plan publishes or tags. Task 10's npm trusted-publisher configuration is settings-only.

## Facts verified during planning (2026-07-08, this worktree)

- `npx vitest run` → exit 0. `npm run lint` → exit 0. Baseline is green.
- `npx tsc -p tsconfig.eslint.json --noEmit` → exit 2 with ~60 errors across 17 test files (categorized in Tasks 1–2). `src/` is clean (it compiles via `npm run build`).
- `main` has **no branch protection or ruleset** (`gh api repos/ironforgesoftware/junco/branches/main/protection` → 404).
- The CLI has no `--version` flag. Smoke assertions use `--help`, `init --yes`, `schema`, `inbox-path`.
- `junco init --yes` in a sandbox writes `$XDG_CONFIG_HOME/junco/config.toml` (config resolution: explicit `--config` > `./config.toml` > XDG default — `src/config.ts` `resolveConfigPath`) and creates the queue dirs + worktree root (`src/wizard.ts:207`).
- `README.md:6` has a CI badge pointing at `workflows/test.yml` — must follow the rename.
- `npm pack` tarball filename: `ironforgesoftware-junco-<version>.tgz` (scope prefix folded in).

---

### Task 1: Add `typecheck` script; complete the incomplete test fixtures

The gap: `tsconfig.eslint.json` includes `tests/`, but nothing runs `tsc` against it — vitest doesn't type-check and `tsconfig.json` excludes tests. Running it today reveals ~26 "incomplete literal" errors: test fixtures built before `Config`, `Ticket`, `PrOutcome`, and `MainLoopDeps` grew fields. This is the documented burn from CLAUDE.md ("Misses fail at _runtime_").

**Files:**

- Modify: `package.json` (add `typecheck` script)
- Modify: `tests/cli.test.ts:367`, `tests/critic.test.ts:44,107`, `tests/daemon.test.ts:42,113`, `tests/dispatch.test.ts:16`, `tests/health.test.ts:18`, `tests/pr.test.ts:75`, `tests/verify.test.ts:13,199,208,224,239,260,277,294,309`, `tests/worktree.test.ts:88`, `tests/finalize.test.ts:68`, `tests/observability.integration.test.ts:41`

**Interfaces:**

- Consumes: `Config`, `Ticket` (`src/types.ts:52,137`), `PrOutcome` (`src/prFlow.ts`), `MainLoopDeps` (`src/daemon.ts`).
- Produces: `npm run typecheck` — the command Tasks 2, 3, 6, and 7 reference. After this task it still fails, but only with the ~34 one-off errors Task 2 fixes.

- [ ] **Step 1: Add the script**

In `package.json` `scripts`, after `"lint"`:

```json
    "typecheck": "tsc -p tsconfig.eslint.json --noEmit",
```

- [ ] **Step 2: Get the authoritative error list**

Run: `npx tsc -p tsconfig.eslint.json --noEmit --noErrorTruncation > /tmp/tsc-errors.txt 2>&1; echo "exit: $?"`
Expected: `exit: 2`. `/tmp/tsc-errors.txt` is the source of truth — the line numbers above may drift a few lines as you edit.

- [ ] **Step 3: Complete the `Config` fixtures**

Errors of the form `missing the following properties from type 'Config': maxTransientRetries, retryBackoffSeconds, maxConcurrent, allowedRepoRoots, ...` or `Type 'number | undefined' is not assignable to type 'number'` (this second form appears in `makeConfig(overrides: Partial<Config>)` helpers whose **base literal** is missing fields — the spread of `Partial` only makes a property non-optional if the base provides it).

Fix pattern: add every field tsc names to the **base literal**, copying values from the complete reference fixture `cfg()` in `tests/runOnce.test.ts` (that file has zero errors). Example for `tests/health.test.ts` `makeConfig` — add to the object literal:

```ts
    maxTransientRetries: 2,
    retryBackoffSeconds: 60,
    maxConcurrent: 1,
    allowedRepoRoots: [],
```

…plus whatever else `--noErrorTruncation` lists for that file (each fixture may be missing a different subset — trust tsc, not this example). Do this in: `cli.test.ts`, `critic.test.ts`, `daemon.test.ts`, `dispatch.test.ts`, `health.test.ts`, `pr.test.ts`, `verify.test.ts`, `worktree.test.ts`.

- [ ] **Step 4: Complete the `Ticket` literals**

`tests/critic.test.ts:107` and the eight `verify.test.ts` sites are missing the same five worker-managed fields. Add to each ticket literal:

```ts
    notBefore: null,
    retryCount: 0,
    tools: null,
    github: null,
    workdir: null,
```

If a file has 3+ sites (verify.test.ts has 8), instead add one local helper near the top and rewrite the sites to use it — complete base first, then spread:

```ts
const makeTicket = (over: Partial<Ticket> = {}): Ticket => ({
  path: "/tmp/t.md",
  id: "t",
  priority: "normal",
  timeoutSeconds: 60,
  body: "",
  frontmatter: {},
  hasRepo: false,
  notBefore: null,
  retryCount: 0,
  tools: null,
  github: null,
  workdir: null,
  ...over,
});
```

(Adjust the default field values to whatever the existing literals in that file use, so test behavior is unchanged.)

- [ ] **Step 5: Complete the `PrOutcome` literals**

`tests/finalize.test.ts:68` (`emptyOutcome` base literal) and `tests/observability.integration.test.ts:41`: add

```ts
    prQueued: false,
    staleBase: false,
```

(Only add `staleBase` where tsc names it — it is optional in some shapes.)

- [ ] **Step 6: Complete `makeDeps` in `tests/daemon.test.ts`**

The `Required<MainLoopDeps>` base literal at ~line 113 is missing `claimFn`, `outboxDrainFn`, and others (tsc names them). Read the `MainLoopDeps` interface in `src/daemon.ts` and add a `vi.fn()` stub for each missing key to the base literal, with a resolved value matching the return type — e.g.:

```ts
    claimFn: vi.fn(async () => null),
```

For `outboxDrainFn`, return a minimal `FlushResult` literal matching its type in `src/githubOutbox.ts` (read it — do not guess field names).

- [ ] **Step 7: Verify only the one-off errors remain**

Run: `npx tsc -p tsconfig.eslint.json --noEmit 2>&1 | grep -c "error TS"`
Expected: ~34 (only errors in `guards`, `cli` (tuple), `daemon` (mock-arg), `health:96`, `githubOutbox`, `outboxCmd`, `prFlow:362`, `tuiPrPreview`). Zero errors mentioning `Config`, `Ticket`, `PrOutcome`, or `MainLoopDeps` completeness.

- [ ] **Step 8: Verify runtime behavior unchanged**

Run: `npx vitest run > /tmp/t1.out 2>&1; echo "exit: $?"; tail -3 /tmp/t1.out`
Expected: `exit: 0`. Also run `npm run lint` → exit 0, and `npx prettier --write` on every touched test file.

- [ ] **Step 9: Commit**

```bash
git add package.json tests/
git commit -m "chore(tests): complete Config/Ticket/PrOutcome/MainLoopDeps fixtures; add typecheck script"
git log --format='%B' -1   # verify: no attribution trailer
```

---

### Task 2: Fix the remaining one-off test type errors — typecheck goes green

**Files:**

- Modify: `tests/guards.test.ts:41,499,507`, `tests/cli.test.ts:595-610`, `tests/daemon.test.ts:488-495`, `tests/health.test.ts:96`, `tests/githubOutbox.test.ts:~28`, `tests/outboxCmd.test.ts`, `tests/prFlow.test.ts:355-368`, `tests/tuiPrPreview.test.tsx:155,166,211`

**Interfaces:**

- Produces: `npm run typecheck` → exit 0. This is the state Tasks 3/6/7 assume.

- [ ] **Step 1: Delete the three unused `@ts-expect-error` directives**

In `tests/guards.test.ts` at ~41, ~499, ~507, tsc reports `Unused '@ts-expect-error' directive` — the guarded call no longer errors (the signature widened). Delete the comment line only; keep the assertion below it:

```ts
const g = new RepetitionGuard();
expect(g.update(42)).toBe(false);
```

If deleting the directive makes tsc flag the call itself (`42` not assignable), keep the directive instead and skip — trust tsc's judgment per site.

- [ ] **Step 2: Type the argless `vi.fn` mocks whose `.mock.calls` are read**

`tests/cli.test.ts` (~598, ~608): `const wizard = vi.fn(async () => 0)` produces a calls tuple of `[]`, so `wizard.mock.calls[0][1]` is a type error. Give the mock the real `runInitWizardFn` signature (from `CliDeps` in `src/cli.ts`):

```ts
const wizard = vi.fn(async (_configPath: string, _opts: { yes?: boolean }) => 0);
```

`tests/daemon.test.ts` (~488-495): same recipe for `startHealthServerFn` — read its parameter type from `MainLoopDeps` in `src/daemon.ts` and type the `vi.fn` callback's parameter accordingly, so `mock.calls[0][0]` has a real type. If the arg type is unwieldy, `const arg = startHealthServerFn.mock.calls[0]![0]!;` non-null assertions are acceptable after typing the fn.

- [ ] **Step 3: Widen the fetch mock in `tests/health.test.ts:96`**

The mock is typed `(url: string, init?: RequestInit) => Promise<Response>` but the seam expects the global `fetch` signature. Change the parameter:

```ts
    (input: string | URL | Request, init?: RequestInit) => ...
```

and use `String(input)` wherever the body compared `url` as a string.

- [ ] **Step 4: Un-`as const` the outbox op fixtures**

`tests/githubOutbox.test.ts` (~13 errors) and `tests/outboxCmd.test.ts` (~6 errors): a shared `LABELS = { kind: "labels", ... } as const` literal is readonly, but `OutboxOp` wants mutable arrays. In each file replace the `as const` annotation with an explicit type:

```ts
const LABELS: Extract<OutboxOp, { kind: "labels" }> = {
  kind: "labels",
  nwo: "a/b",
  issue: 7,
  add: ["junco:approved"],
  remove: [],
};
```

(Import `OutboxOp` from `../src/githubOutbox.js` if not already imported. Keep the exact field values the file already uses.)

- [ ] **Step 5: Fix the `sessionFactoryFor` shape in `tests/prFlow.test.ts:362`**

The seam type is `(cfg: Config, cwd: string) => () => Promise<AgentSessionLike>` but the test returns the awaited promise directly. Preserve the `agentCalled` semantics by setting the flag inside the returned thunk:

```ts
      sessionFactoryFor: (cfg2, cwd) => () => {
        agentCalled = true;
        return commitFactory({ commit: true })(cfg2, cwd)();
      },
```

- [ ] **Step 6: Add the missing `focused` prop in `tests/tuiPrPreview.test.tsx`**

Three `<PrPreview ...>` renders (~155, ~166, ~211) lack the required `focused` prop. The tests currently run with `focused` as `undefined` (falsy), so preserve runtime behavior exactly:

```tsx
<PrPreview pr={testPr} branchPrefix="junco/" now={NOW} height={27} focused={false} />
```

- [ ] **Step 7: Verify typecheck green, suite green**

Run: `npm run typecheck; echo "exit: $?"`
Expected: `exit: 0`, no output.
Run: `npx vitest run > /tmp/t2.out 2>&1; echo "exit: $?"; tail -3 /tmp/t2.out`
Expected: `exit: 0`, same test count as baseline (~700).
Run: `npm run lint` → exit 0. `npx prettier --write` on touched files.

- [ ] **Step 8: Commit**

```bash
git add tests/
git commit -m "chore(tests): fix remaining type errors so tests/ type-checks clean"
git log --format='%B' -1   # verify: no attribution trailer
```

---

### Task 3: Restructure `test.yml` into `quality-gate.yml`

**Files:**

- Rename+rewrite: `.github/workflows/test.yml` → `.github/workflows/quality-gate.yml`

**Interfaces:**

- Produces: workflow `Quality Gate`; job id `test` with display name `test (<os>, node <version>)`; step `npm run typecheck` (from Task 1). Task 4 adds jobs `smoke` and `gate` to this same file. The final required-check context (Task 10) is `quality-gate` — defined by Task 4's gate job, not this task.

- [ ] **Step 1: Rename and rewrite the workflow**

```bash
git mv .github/workflows/test.yml .github/workflows/quality-gate.yml
```

Replace its entire content with:

```yaml
name: Quality Gate

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

# One run per ref; force-pushes to a PR cancel the superseded run. Pushes to
# main are never cancelled (keep an unbroken history of main results).
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  test:
    name: test (${{ matrix.os }}, node ${{ matrix.node }})
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: ["22.19.0", "24"] # engines floor (exact) + current LTS
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run format:check
      - run: npm run typecheck
      # repo/pr/worktree tests create real commits in temp repos
      - run: |
          git config --global user.email "ci@example.invalid"
          git config --global user.name "junco-ci"
      - run: npm run build
      - run: npm test
```

Note the trigger change: `push` is now `main`-only (PRs cover branches — the old `feat/**` push trigger double-ran every PR commit), and `workflow_dispatch` allows manual runs of any ref.

- [ ] **Step 2: Sanity-check the YAML parses**

Run: `node -e "const {readFileSync}=require('fs'); require('/Users/alxedelweiss/junco/.claude/worktrees/ci_cd/node_modules/yaml').parse(readFileSync('.github/workflows/quality-gate.yml','utf8')); console.log('yaml ok')"`
Expected: `yaml ok` (the repo already depends on the `yaml` package).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/
git commit -m "feat(ci): restructure test workflow into a hardened Quality Gate"
git log --format='%B' -1   # verify: no attribution trailer
```

---

### Task 4: Package smoke test + aggregate gate job

Nothing today tests the published artifact: the `files` allowlist could drop `templates/` or the `bin` wiring could break with CI green. This task adds a script that packs the tarball, installs it into a scratch prefix, and drives the installed CLI in a sandboxed HOME — plus the `gate` job that ties every leg into the one status check.

**Files:**

- Create: `scripts/package-smoke.sh`
- Modify: `.github/workflows/quality-gate.yml` (append two jobs)

**Interfaces:**

- Consumes: job id `test` (Task 3); a built `dist/` (the workflow builds before calling the script).
- Produces: job ids `smoke` and `gate`; **check context `quality-gate`** (the gate job's display name) — the exact string Task 10's ruleset requires.

- [ ] **Step 1: Write the smoke script**

Create `scripts/package-smoke.sh`:

```bash
#!/usr/bin/env bash
# Package smoke test: pack the npm tarball, install it into a scratch prefix,
# and drive the installed CLI in a sandboxed HOME. This exercises the `files`
# allowlist, bin wiring, and init scaffold — the surface unit tests never see.
# Requires a prior `npm run build` (npm pack ships dist/ as-built).
set -euo pipefail

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

npm pack --pack-destination "$TMP" >/dev/null
npm install -g --prefix "$TMP/prefix" "$TMP"/ironforgesoftware-junco-*.tgz >/dev/null
JUNCO="$TMP/prefix/bin/junco"

# Sandbox: config resolution prefers ./config.toml then XDG — point both at TMP
# so the smoke run can never touch a real setup.
SB="$TMP/sandbox"
mkdir -p "$SB"
cd "$SB"
export HOME="$SB"
export XDG_CONFIG_HOME="$SB/.config"

"$JUNCO" --help >/dev/null

"$JUNCO" init --yes
CONFIG="$SB/.config/junco/config.toml"
[ -f "$CONFIG" ] || { echo "FAIL: init --yes did not write $CONFIG"; exit 1; }

"$JUNCO" schema | node -e "JSON.parse(require('node:fs').readFileSync(0, 'utf8'))" \
  || { echo "FAIL: schema did not print valid JSON"; exit 1; }

INBOX="$("$JUNCO" inbox-path)"
[ -d "$INBOX" ] || { echo "FAIL: inbox dir missing: $INBOX"; exit 1; }

echo "package smoke OK (config: $CONFIG, inbox: $INBOX)"
```

Then: `chmod +x scripts/package-smoke.sh`

- [ ] **Step 2: Run it locally (macOS leg)**

Run: `npm run build && bash scripts/package-smoke.sh`
Expected: final line `package smoke OK (...)`. If any assertion fails, fix the script's expectations against actual CLI behavior (read `src/cli.ts` / `src/wizard.ts`) — do not weaken an assertion to green it without understanding why.

- [ ] **Step 3: Append the `smoke` and `gate` jobs**

Append to `.github/workflows/quality-gate.yml` (same indentation level as `test:`):

```yaml
smoke:
  name: package smoke (${{ matrix.os }})
  strategy:
    fail-fast: false
    matrix:
      os: [ubuntu-latest, macos-latest]
  runs-on: ${{ matrix.os }}
  timeout-minutes: 10
  steps:
    - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
    - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
      with:
        # engines floor: the shipped tarball must install and run on the
        # minimum supported node
        node-version: "22.19.0"
        cache: npm
    - run: npm ci
    - run: npm run build
    - run: bash scripts/package-smoke.sh

# The single status check that ties every environment leg together. Branch
# protection requires exactly this context: "quality-gate".
gate:
  name: quality-gate
  needs: [test, smoke]
  if: always()
  runs-on: ubuntu-latest
  timeout-minutes: 5
  steps:
    - name: Fail unless every leg succeeded
      if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped')
      run: |
        echo "::error::A quality-gate leg did not succeed — test=${{ needs.test.result }} smoke=${{ needs.smoke.result }}"
        exit 1
    - name: All legs green
      run: echo "quality gate passed — test=${{ needs.test.result }} smoke=${{ needs.smoke.result }}"
```

- [ ] **Step 4: Sanity-check YAML + commit**

Run the same `yaml.parse` one-liner from Task 3 Step 2 → `yaml ok`.

```bash
git add scripts/package-smoke.sh .github/workflows/quality-gate.yml
git commit -m "feat(ci): package smoke test + aggregate quality-gate check"
git log --format='%B' -1   # verify: no attribution trailer
```

---

### Task 5: Dependabot for Actions pins

SHA pins rot without automation. Dependabot's `github-actions` ecosystem bumps the SHA and keeps the `# vX.Y.Z` comment in sync.

**Files:**

- Create: `.github/dependabot.yml`

- [ ] **Step 1: Write the config**

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
    commit-message:
      prefix: "chore(ci)"
```

(Deliberately no `npm` ecosystem entry: dependencies are exact-pinned by policy and updated manually; add an npm block later only if the maintainer wants the PR noise.)

- [ ] **Step 2: Commit**

```bash
git add .github/dependabot.yml
git commit -m "chore(ci): dependabot updates for github-actions pins"
git log --format='%B' -1   # verify: no attribution trailer
```

---

### Task 6: Publish workflow — OIDC trusted publishing + preflights

**Files:**

- Rewrite: `.github/workflows/publish.yml`

**Interfaces:**

- Consumes: `npm run typecheck` (Task 1).
- Produces: a publish job that authenticates via OIDC only. **`secrets.NPM_TOKEN` is no longer referenced** — but the secret itself is retired in Task 10, _after_ the first successful OIDC publish.

- [ ] **Step 1: Rewrite `publish.yml`**

```yaml
name: Publish to npm

# Publishes the package whenever a GitHub Release is published.
#
# Release flow (see CLAUDE.md "Git & release" — Release HOLD applies):
#   1. Bump "version" in package.json (+ update CHANGELOG.md) via a PR to main.
#   2. After merge + quality gate green: git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
#   3. Create a GitHub Release for that tag (gh release create vX.Y.Z ...).
#
# Auth is npm "trusted publishing" (GitHub OIDC) — no NPM_TOKEN secret. The
# package's Trusted Publisher on npmjs.com must point at this repo + this
# workflow filename (publish.yml). Deliberately NOT set here:
#   - setup-node's registry-url: it writes an .npmrc _authToken placeholder,
#     and any token (even a placeholder) makes npm skip OIDC.
#   - setup-node's cache: restoring a cache into a publishing job is a
#     cache-poisoning vector; a cold npm ci costs seconds.

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write # OIDC token for npm trusted publishing + provenance

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: "24"
      # Trusted publishing needs npm >= 11.5.1; node's bundled npm may lag.
      - run: npm install -g npm@latest
      - name: Verify release tag matches package.json version
        run: |
          pkg="v$(node -p "require('./package.json').version")"
          if [ "$GITHUB_REF_NAME" != "$pkg" ]; then
            echo "::error::release tag $GITHUB_REF_NAME does not match package.json version $pkg"
            exit 1
          fi
      - run: npm ci
      - run: npm run lint
      - run: npm run format:check
      - run: npm run typecheck
      # `npm publish` runs the prepublishOnly hook (npm run build && npm test)
      # before publishing. --provenance stays explicit: npm docs say trusted
      # publishing implies it, but that default has not held reliably.
      - run: npm publish --provenance --access public
```

- [ ] **Step 2: Sanity-check YAML + commit**

Run the `yaml.parse` one-liner (Task 3 Step 2, pointed at `publish.yml`) → `yaml ok`.

```bash
git add .github/workflows/publish.yml
git commit -m "feat(ci): npm trusted publishing (OIDC) + tag/version preflight in publish"
git log --format='%B' -1   # verify: no attribution trailer
```

---

### Task 7: Docs sync — CLAUDE.md and the README badge

**Files:**

- Modify: `CLAUDE.md` (Commands table, testing gotcha, CI reference, release flow)
- Modify: `README.md:6` (badge URL)

- [ ] **Step 1: Update the README badge**

Replace both `test.yml` occurrences on line 6 with `quality-gate.yml`:

```markdown
[![CI](https://github.com/ironforgesoftware/junco/actions/workflows/quality-gate.yml/badge.svg)](https://github.com/ironforgesoftware/junco/actions/workflows/quality-gate.yml)
```

- [ ] **Step 2: Update CLAUDE.md**

Four edits (re-read the file first; quote exact current text before replacing):

1. Commands table — add a row after Lint, and update the full gate:
   - New row: `| Typecheck | \`npm run typecheck\` (tsc over src/ + tests/ via \`tsconfig.eslint.json\` — vitest does not type-check) |`
   - Full gate row becomes: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`
2. The sentence `CI (\`.github/workflows/test.yml\`) runs it on push/PR across ubuntu/macos × node 22.19/24.`→`CI (\`.github/workflows/quality-gate.yml\`) runs it on PRs and pushes to main across ubuntu/macos × node 22.19/24, plus a packaged-CLI smoke test; the aggregate \`quality-gate\` check is required to merge.`
3. Testing gotcha #1: replace `Misses fail at *runtime* (\`undefined\` arithmetic), not compile time: vitest doesn't type-check and \`tsconfig.json\` excludes \`tests/\`.`with`\`npm run typecheck\` catches misses at CI time (vitest doesn't type-check and \`tsconfig.json\` excludes \`tests/\` — the eslint tsconfig covers them).`
4. Release flow: in the "Once approved" sentence, change `bump \`package.json\` + \`CHANGELOG.md\` (Keep a Changelog) → merge to \`main\` → push → CI green`to`bump \`package.json\` + \`CHANGELOG.md\` (Keep a Changelog) via PR → quality gate green → merge`and change`→ npm publish with provenance`to`→ npm publish via OIDC trusted publishing with provenance (no NPM_TOKEN)`.

- [ ] **Step 3: Check for stragglers**

Run: `grep -rn "workflows/test.yml\|NPM_TOKEN" --include="*.md" . | grep -v node_modules | grep -v superpowers/plans`
Expected: no hits outside this plan document. Fix any that appear.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: sync CLAUDE.md and README badge with the quality-gate workflow"
git log --format='%B' -1   # verify: no attribution trailer
```

---

### Task 8: Static validation of the workflow YAML

**Files:** none modified unless findings require it.

- [ ] **Step 1: Run actionlint**

```bash
command -v actionlint >/dev/null || brew install actionlint
actionlint
```

Expected: no output (clean). Fix any findings (expression typos, invalid `needs`, shellcheck issues in `run:` blocks) and re-run.

- [ ] **Step 2: Run zizmor**

```bash
command -v zizmor >/dev/null || brew install zizmor
zizmor .github/workflows/
```

Expected: no High findings. Known-acceptable informational findings, if flagged: `cache: npm` in the _quality-gate_ jobs (cache poisoning only matters for publishing jobs, which deliberately have no cache) and `workflow_dispatch` presence. Anything else: fix it.

If brew cannot install either tool, note it in the commit/PR body and rely on Task 9's live run — do not silently skip.

- [ ] **Step 3: Commit any fixes**

```bash
git add .github/workflows/ && git commit -m "chore(ci): address actionlint/zizmor findings"
```

(Skip the commit if there were no findings.)

---

### Task 9: Push, open the PR, watch the gate go green live

- [ ] **Step 1: Commit the plan document** (if not already committed)

```bash
git add docs/superpowers/plans/2026-07-08-ci-quality-gate.md
git commit -m "docs(plans): check in the ci-quality-gate implementation plan"
```

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/ci-quality-gate
gh pr create --title "feat(ci): quality gate — aggregate check, typecheck, package smoke, OIDC publish" --body "$(cat <<'EOF'
Restructures CI into a Quality Gate workflow: the 4-leg test matrix (now with a tsc pass over tests/), a 2-leg packaged-CLI smoke test, and one aggregate `quality-gate` check that ties every environment together. Hardens both workflows (SHA-pinned actions, least-privilege permissions, timeouts, concurrency), adds Dependabot for action pins, and moves publishing to npm trusted publishing (OIDC) with a tag/version preflight.

Also fixes ~60 pre-existing type errors in tests/ that the new typecheck gate surfaced — including the CLAUDE.md-documented incomplete-Config-fixture class.

Follow-ups after merge (settings-side, tracked in the plan doc): main branch ruleset requiring `quality-gate`, CodeQL default setup, npm Trusted Publisher configuration, NPM_TOKEN retirement.
EOF
)"
```

(No AI attribution in the PR body.)

- [ ] **Step 3: Watch the run**

```bash
gh pr checks --watch
```

Expected: 7 green checks — 4× `test (...)`, 2× `package smoke (...)`, 1× `quality-gate`. The PR run executes the PR's own workflow definition, so this is a true live test of the new gate. If a leg fails, fix on the branch (systematic-debugging) and re-watch; macOS legs may queue slowly — that is not a failure.

- [ ] **Step 4: Hand off for merge**

Follow superpowers:finishing-a-development-branch. Merging is the maintainer's call.

---

### Task 10: Post-merge settings (ruleset, CodeQL, npm trusted publisher)

Run these only **after** the PR merges (the ruleset requires the `quality-gate` context, which must exist on `main`'s workflow for new PRs).

- [ ] **Step 1: Create the `main` ruleset**

```bash
gh api --method POST repos/ironforgesoftware/junco/rulesets --input - <<'JSON'
{
  "name": "main quality gate",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge", "squash", "rebase"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "quality-gate", "integration_id": 15368 }
        ]
      }
    }
  ],
  "bypass_actors": []
}
JSON
```

(`integration_id` 15368 = GitHub Actions, so only Actions can satisfy the check. `bypass_actors` is empty — every change to `main`, including release version bumps, now goes through a PR + green gate. If that ever chafes, add `{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}` for admin bypass.)

Verify: `gh api repos/ironforgesoftware/junco/rulesets --jq '.[].name'` → includes `main quality gate`. Then confirm enforcement: `git push origin HEAD:main` from any non-PR commit should be rejected.

- [ ] **Step 2: Enable CodeQL default setup**

```bash
gh api --method PATCH repos/ironforgesoftware/junco/code-scanning/default-setup --input - <<< '{"state":"configured"}'
```

Verify: `gh api repos/ironforgesoftware/junco/code-scanning/default-setup --jq '.state'` → `configured`.

- [ ] **Step 3: Configure the npm Trusted Publisher (maintainer-only, manual)**

Only someone logged into npmjs.com with publish rights can do this. On `https://www.npmjs.com/package/@ironforgesoftware/junco/access`: add a Trusted Publisher → GitHub Actions → organization `ironforgesoftware`, repository `junco`, workflow filename `publish.yml`, environment blank. **Do this before the next release** — with the workflow no longer using NPM_TOKEN, publishing fails loudly until the publisher is configured (recoverable: configure, then re-run the failed workflow run).

- [ ] **Step 4: Retire NPM_TOKEN after the first successful OIDC publish**

After the next release publishes successfully via OIDC (verify with `npm view @ironforgesoftware/junco version` and the provenance badge on the npm page): delete the `NPM_TOKEN` repo secret (`gh secret delete NPM_TOKEN`) and revoke the underlying npm automation token on npmjs.com. Not before — it is the rollback path if OIDC misbehaves on first use.

---

## Self-review notes

- Every user requirement maps to a task: "quality gate" naming + environment tie-together (Tasks 3–4), typecheck gap (Tasks 1–2), packaging gap (Task 4), duplicate runs + hardening (Task 3), Dependabot (Task 5), OIDC publish + preflight (Task 6), branch enforcement + CodeQL (Task 10), docs honesty (Task 7).
- Type/name consistency: job ids `test`/`smoke`/`gate`; check context `quality-gate` used identically in Task 4's job name and Task 10's ruleset; `npm run typecheck` defined in Task 1 and consumed in Tasks 2/3/6/7.
- Known risk: the exact "missing 3 more" Config fields vary per fixture — Task 1 Step 2's `--noErrorTruncation` run is the source of truth, and Step 8's full-suite run guards against behavior drift.
