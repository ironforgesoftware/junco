# Sandbox fs-tool TOCTOU: pure-JS swap-exclusion (#159)

**Date:** 2026-07-11
**Status:** draft

## Problem

The in-process fs-tool path jail (`src/agent/sandbox/`) resolves a tool-supplied
path synchronously (`canonicalize` → `assertWriteAllowed`/`assertReadAllowed`)
and then performs the syscall (`open`/`mkdir`/`readFile`/…) asynchronously
later. Between the check and the syscall, a concurrent actor can swap a path
component to a symlink pointing outside the jail; the kernel follows it at
syscall time and the operation escapes (issue #159, follow-up to #158). `O_NOFOLLOW`
guards only the **final** component of writes; `mkdir` and reads have no atomic
backstop at all. These are timing-only, race-only gaps — no escape was
demonstrated, not a regression over the no-sandbox baseline, and the sandbox is
opt-in (`sandbox.enabled` defaults false).

## Key insight (scopes the fix)

**Only the `bash` tool can create/swap symlinks.** The fs-tools (`write`,
`edit`, `mkdir`) have no symlink-creation capability. So the _only_ concurrent
swapper is a bash-spawned process, and the intermediate-component TOCTOU is
specifically a **bash-concurrent-with-an-fs-op** race. Eliminating overlap
between bash execution and any fs-op's check→syscall window closes **all three
gaps** (write-intermediate, `mkdir`, read) with one mechanism — no atomic
kernel resolution required.

The alternative — a native `openat2`/`openat` resolver — is the bulletproof
gold standard but requires native code (Node exposes neither `openat2`,
`openat`, nor `F_GETPATH`) and a prebuild/platform matrix, disproportionate for
an opt-in, undemonstrated, defense-in-depth race in a pure-TS project. It is
retained as the documented long-term upgrade path.

## Design

### 1. Per-session readers-writer lock — `src/agent/sandbox/opLock.ts`

An async RW lock:

- **fs-ops** (read/write/edit/mkdir/ls/find/grep) acquire it **shared** — they
  still run concurrently with each other (none can plant a symlink, so fs↔fs is
  safe).
- **bash** acquires it **exclusive** — waits for in-flight fs-ops, blocks new
  ones for its whole subprocess lifetime.
- **Writer-priority**: a pending exclusive (bash) request blocks new shared
  acquisitions, so a stream of fs-ops cannot starve bash.
- **Invariant**: an fs-op holds shared across its _entire_
  `assert*Allowed`→`open`→read/write span; bash holds exclusive across
  spawn→exit→reap. Therefore no bash execution ever overlaps an fs-op window ⇒
  no component can be swapped mid-op. `O_NOFOLLOW` on the write leaf stays as
  belt-and-suspenders.
- No hold-and-wait (fs-ops never wait on bash-produced state), so no deadlock.

### 2. Process-group reaping — `src/agent/sandbox/bashOps.ts`

Spawn bash with `detached: true` (own process group); on `close`/timeout/abort,
`process.kill(-pid, "SIGKILL")` the **group** so a backgrounded swapper
(`ln -s … &`) cannot survive _between_ bash calls. On Linux, ensure the bwrap
wrapper carries `--die-with-parent` (in `backend.ts`'s `spawnArgv`) so the
namespace tears down and reaps even `setsid`-escaping descendants when the
bwrap process is killed. Reaping is good hygiene independent of #159 (no
lingering agent processes after a ticket).

### 3. Wiring — `src/agent/sandbox/index.ts` (`buildSandbox`)

Create one `OpLock` per sandbox build; inject it into every
`makeJailed*Operations` wrapper (acquire-shared around the op body) and
`makeSandboxedBashOperations` (acquire-exclusive around exec + reap). The lock
exists only in a sandboxed build, so there is **zero cost when
`sandbox.enabled` is false**.

## Testing

- **Lock unit tests** (`tests/sandboxOpLock.test.ts`): shared acquisitions run
  concurrently; an exclusive holder excludes all shared and vice versa;
  writer-priority (a pending exclusive blocks new shared); release ordering; no
  deadlock. Deterministic (manual promise gating), no wall-clock races.
- **Mutual-exclusion property** (fsOps/bashOps wiring test): instrument the
  jailed ops + bash exec with enter/exit markers sharing the lock; assert the
  recorded intervals for a bash exec and any fs-op **never interleave** — a
  direct assertion of the invariant, not a flaky swap race.
- **Reaping** (`sandboxBashOps.test.ts`): a bash command that backgrounds a child
  → after `exec` resolves, the child's process group received SIGKILL (assert
  via injected `spawnFn`/kill spy; a real-process integration variant may be
  platform-gated like the existing sandbox integration tests).
- **Regression**: existing `tests/sandbox*.test.ts` stay green; full gate green.

## Non-goals / documented residual

- **Not** the native atomic resolver — deferred (issue #159 stays open, narrowed).
- **Residual** (documented in code + `docs/configuration.md`/sandbox section): a
  `setsid`-escaping background process on **macOS** (no PID namespace) can
  outlive the process-group kill; only the native `*at` resolver fully closes
  it. On Linux, bwrap namespace teardown reaps it.
- **Throughput**: under `sandbox.enabled`, a long bash blocks concurrent
  fs-ops. Only bites if the SDK issues parallel tool calls; the inherent price
  of the invariant, acceptable for the opt-in security mode. Documented.

## Risks & mitigations

- **RW-lock correctness/starvation** → small, fully unit-tested primitive with
  writer-priority; deterministic tests.
- **Reaping breaking a legit backgrounded process** → junco's agent runs
  build/test commands, not daemons; a sandboxed agent leaving live processes is
  itself a containment gap, so reaping is desirable. Behavior documented.
- **Lock scope too narrow** (missing an fs-op) → wrap at the single
  `buildSandbox` seam so every sandboxed op is covered by construction; a test
  enumerates the wrapped tool set.
