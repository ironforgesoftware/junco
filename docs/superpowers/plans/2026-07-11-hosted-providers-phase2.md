# Hosted Providers Phase 2 (Provider Gate + Resilience) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make junco's queue honest about metered, auth-gated endpoints — classify provider failures from error text, pause claiming loudly (instead of burning retry budget or wedging silently), and stop paying for probe traffic. PR 2 of 3 for `docs/superpowers/specs/2026-07-11-hosted-providers-design.md` (§3).

**Architecture:** Two new pure modules — `src/providerFailure.ts` (text → failure class) and `src/providerGate.ts` (a latching state machine consumed by the claim gate, `/health`, `/ready`, TUI, and metrics). A count-free requeue primitive stamps `not_before` without burning `retry_count` for infrastructure failures. The daemon owns one gate instance + one TTL-cached probe, threads them through `runOnce`/`prFlow`/`runScheduler`/health server, and clears latches on config hot-reload. `worker.endpointProbe` (`auto`/`always`/`never`) makes probing policy explicit.

**Tech Stack:** TypeScript strict/ESM, zod, vitest. No new dependencies; no SDK import outside `src/agent/session.ts`.

## Global Constraints

- Suite green at every commit; conventional commits; **no AI attribution trailers of any kind**.
- No new dependencies. `src/ticketSchema.ts` untouched (the `not_before`/`retry_count` frontmatter keys already exist; no new ticket-facing keys).
- Never import the Pi SDK at module top level in `src/`; runtime `await import` stays in `src/agent/session.ts`.
- Prettier on touched files before each commit; re-read files before editing (prettier may reformat).
- Vitest exit-code trap: capture `$?` directly, never pipe into a filter.
- Adding `Config` fields ⇒ fixture sweep via `npm run typecheck` (the known `makeConfig` helpers gotcha).
- Scheduler/daemon tests: never fake `sleep` as instant-resolve without yielding a real tick (`await new Promise((r) => setTimeout(r, 1))`); TUI tests: loop-until-condition, never one fixed tick.
- Classification decisions (spec §3): `auth`/`quota`/`model_not_found` → **latch** + count-free requeue; `rate_limit` → until-based block with doubling backoff (base `worker.retryBackoffSeconds`, cap 900 s) + count-free requeue; `outage` → keep today's count-incrementing transient requeue AND a single-interval non-latching gate block; `unknown` → today's behavior exactly.
- Latches clear on: session success, config hot-reload apply, daemon restart.
- Phase 3 (doctor/wizard/cost/docs repositioning) is a separate plan. Do not implement it here. `budget_exhausted` is a Phase 3 gate state; the enum here must be extensible but NOT include it yet.

---

### Task 1: `classifyProviderFailure` — error text → failure class

**Files:**

- Create: `src/providerFailure.ts`
- Test: `tests/providerFailure.test.ts` (new)

**Interfaces:**

- Produces:

```ts
export type ProviderFailureClass =
  | "auth"
  | "quota"
  | "model_not_found"
  | "rate_limit"
  | "outage"
  | "unknown";
export function classifyProviderFailure(errorText: string | null | undefined): ProviderFailureClass;
```

- [ ] **Step 1: Write the failing tests** (`tests/providerFailure.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { classifyProviderFailure } from "../src/providerFailure.js";

describe("classifyProviderFailure", () => {
  it("null/undefined/empty → unknown", () => {
    expect(classifyProviderFailure(null)).toBe("unknown");
    expect(classifyProviderFailure(undefined)).toBe("unknown");
    expect(classifyProviderFailure("")).toBe("unknown");
  });

  it("auth: 401/403/unauthorized/invalid api key/authentication error", () => {
    for (const s of [
      '401 {"type":"error"} invalid x-api-key',
      "HTTP 403 Forbidden",
      "Unauthorized",
      "invalid_api_key: Incorrect API key provided",
      "authentication_error: invalid bearer token",
    ]) {
      expect(classifyProviderFailure(s), s).toBe("auth");
    }
  });

  it("quota beats rate_limit — insufficient_quota rides a 429", () => {
    expect(classifyProviderFailure("429 insufficient_quota: You exceeded your current quota")).toBe(
      "quota",
    );
    expect(classifyProviderFailure("billing hard limit reached")).toBe("quota");
  });

  it("model_not_found variants → model_not_found", () => {
    for (const s of [
      "404 model_not_found: The model `gpt-x` does not exist",
      'model "claude-nope" not found',
      "unknown model: qwen-9000",
    ]) {
      expect(classifyProviderFailure(s), s).toBe("model_not_found");
    }
  });

  it("rate_limit: 429 / rate limit / overloaded / too many requests", () => {
    for (const s of [
      "429 Too Many Requests",
      "rate_limit_error: rate limited",
      "overloaded_error: Overloaded",
    ]) {
      expect(classifyProviderFailure(s), s).toBe("rate_limit");
    }
  });

  it("outage: 5xx / network errnos / fetch failed", () => {
    for (const s of [
      "502 Bad Gateway",
      "503 Service Unavailable",
      "internal server error",
      "connect ECONNREFUSED 127.0.0.1:1234",
      "read ECONNRESET",
      "getaddrinfo ENOTFOUND api.example.com",
      "fetch failed",
      "socket hang up",
      "ETIMEDOUT",
    ]) {
      expect(classifyProviderFailure(s), s).toBe("outage");
    }
  });

  it("ordinary agent text and guard kills → unknown", () => {
    expect(classifyProviderFailure("agent looped writing the same file")).toBe("unknown");
    expect(classifyProviderFailure("run aborted: output budget exceeded")).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/providerFailure.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement** (`src/providerFailure.ts`)

```ts
/**
 * Classify a provider/session error string into an infrastructure failure
 * class. The SDK flattens HTTP status into display text (no structured codes
 * reach the event stream — verified against pi-coding-agent 0.80.3), so this
 * is deliberately text-pattern based, mirroring the SDK's own retry matcher.
 * Order matters: quota errors ride a 429, so quota is checked before
 * rate_limit; model_not_found often carries a 404 that must not read as
 * outage.
 */
export type ProviderFailureClass =
  | "auth"
  | "quota"
  | "model_not_found"
  | "rate_limit"
  | "outage"
  | "unknown";

const QUOTA = /insufficient[_ ]quota|exceeded your current quota|billing/i;
const AUTH =
  /\b40[13]\b|unauthorized|forbidden|invalid[_ -]?(?:api[_ -]?key|x-api-key|bearer token)|authentication[_ -]?(?:error|failed)|permission denied/i;
const MODEL_NOT_FOUND =
  /model[_ ]not[_ ]found|model[^\n]{0,60}(?:not found|does not exist)|unknown model/i;
const RATE_LIMIT = /\b429\b|rate[_ -]?limit|overloaded|too many requests/i;
const OUTAGE =
  /\b5\d{2}\b|bad gateway|service unavailable|internal server error|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|socket hang up/;

export function classifyProviderFailure(
  errorText: string | null | undefined,
): ProviderFailureClass {
  if (!errorText) return "unknown";
  if (QUOTA.test(errorText)) return "quota";
  if (AUTH.test(errorText)) return "auth";
  if (MODEL_NOT_FOUND.test(errorText)) return "model_not_found";
  if (RATE_LIMIT.test(errorText)) return "rate_limit";
  if (OUTAGE.test(errorText)) return "outage";
  return "unknown";
}
```

- [ ] **Step 4: Run** `npx vitest run tests/providerFailure.test.ts` — PASS.

- [ ] **Step 5: Commit** `feat(gate): classifyProviderFailure — text-based provider failure classes`

---

### Task 2: capture the assistant message's errorMessage in RunResult

First-attempt non-retryable errors never emit `auto_retry_end`, so today `RunResult.errorMessage` stays null with `stopReason:"error"` — classification would see nothing.

**Files:**

- Modify: `src/agent/runResult.ts` (the `turn_end` case, ~line 61)
- Test: `tests/session.test.ts` (the `runAgent` describe — follow its fake-session event pattern)

**Interfaces:** `RunResult.errorMessage` now also carries a first-attempt error. `auto_retry_end.finalError` still wins (it is the settled final error after retries).

- [ ] **Step 1: Failing test** — in `tests/session.test.ts`, using the file's existing fake-session harness, emit a `turn_end` whose `message` is `{ role: "assistant", stopReason: "error", errorMessage: "401 invalid x-api-key", usage: { input: 0, output: 0 } }` with NO `auto_retry_end`, then assert `result.errorMessage === "401 invalid x-api-key"` and `result.stopReason === "error"`. Second test: when both a `turn_end` errorMessage AND a later `auto_retry_end` (`finalError: "final"`) arrive, `result.errorMessage === "final"`.

- [ ] **Step 2: Run** `npx vitest run tests/session.test.ts` — the first new test FAILS (errorMessage null).

- [ ] **Step 3: Implement** — in the `turn_end` case of `src/agent/runResult.ts`, after the `stopReason` capture:

```ts
if (e.message?.stopReason) this.stopReason = e.message.stopReason;
// First-attempt non-retryable errors never emit auto_retry_end (the
// SDK only fires it when a retry was attempted) — the assistant
// message's errorMessage is the only record. auto_retry_end's
// finalError still overwrites this when it fires.
if (e.message?.errorMessage && this.errorMessage === null) {
  this.errorMessage = String(e.message.errorMessage);
}
```

and change the `auto_retry_end` case to always overwrite:

```ts
      case "auto_retry_end":
        if (e.finalError) this.errorMessage = String(e.finalError);
        break;
```

(the `auto_retry_end` case is already exactly this — verify, don't duplicate).

- [ ] **Step 4: Run** `npx vitest run tests/session.test.ts` — PASS. Full suite green.

- [ ] **Step 5: Commit** `fix(agent): capture first-attempt assistant errorMessage into RunResult`

---

### Task 3: `ProviderGate` — the latching state machine

**Files:**

- Create: `src/providerGate.ts`
- Test: `tests/providerGate.test.ts` (new)

**Interfaces:**

- Consumes: `ProviderFailureClass` (Task 1).
- Produces (exact — Tasks 5, 6, 8, 9, 11 consume these):

```ts
export type GateStateKind =
  | "ok"
  | "auth_error"
  | "quota_exhausted"
  | "misconfig"
  | "rate_limited"
  | "outage_backoff";
export interface GateStatus {
  state: GateStateKind;
  reason: string | null; // human-readable cause, e.g. the classified error text
  since: string | null; // ISO — when the non-ok state was entered
  until: string | null; // ISO — rate_limited/outage_backoff expiry; null for latches
}
export interface ProviderGateOpts {
  retryBackoffSeconds: number; // base for rate-limit doubling and outage block
  now?: () => number; // injectable clock (tests)
  onTransition?: (from: GateStateKind, to: GateStateKind) => void; // daemon wires metrics
}
export class ProviderGate {
  constructor(opts: ProviderGateOpts);
  reportFailure(cls: ProviderFailureClass, reason: string): void;
  reportSuccess(): void; // any successful session clears everything
  clearLatched(): void; // config hot-reload apply / operator action
  status(): GateStatus; // until-based states auto-expire to ok on read
  claimBlockReason(): string | null; // null = claiming allowed
  notBeforeIso(): string; // stamp for count-free requeues
}
```

Semantics (each is a test):

- `auth` → `auth_error`, `quota` → `quota_exhausted`, `model_not_found` → `misconfig`: **latched** (no `until`); `claimBlockReason()` non-null until `reportSuccess()`/`clearLatched()`.
- `rate_limit` → `rate_limited` with `until = now + min(retryBackoffSeconds × 2^streak, 900) s`; consecutive rate-limit reports double the streak; `reportSuccess()` resets it. `status()` auto-expires past `until` back to `ok` (and fires `onTransition`).
- `outage` → `outage_backoff` with `until = now + retryBackoffSeconds` (no doubling, non-latching) — does NOT overwrite an existing latched state.
- `unknown` → no-op.
- A latched state is never downgraded by a later `rate_limit`/`outage` report (latch wins).
- `notBeforeIso()`: until-based state → `until`; latched → `now + retryBackoffSeconds`; ok → `now`.
- `onTransition` fires only on actual state changes (not on repeated same-class reports).

- [ ] **Step 1: Failing tests** — write `tests/providerGate.test.ts` covering every bullet above with an injectable fake clock (`let t = 0; const now = () => t;`). Include: doubling sequence 60→120→240→480→900→900 (cap) for `retryBackoffSeconds: 60`; latch-wins-over-429; outage-does-not-overwrite-latch; auto-expiry fires `onTransition("rate_limited","ok")`.

- [ ] **Step 2: Run** — FAIL (module missing).

- [ ] **Step 3: Implement** `src/providerGate.ts` per the semantics. Keep it dependency-free (no metrics/log imports — the daemon wires `onTransition`).

- [ ] **Step 4: Run** — PASS. Full suite green.

- [ ] **Step 5: Commit** `feat(gate): ProviderGate — latching provider-failure state machine`

---

### Task 4: count-free requeue — `requeueTicketKeepBudget`

**Files:**

- Modify: `src/requeue.ts`
- Test: `tests/requeue.test.ts` (or the file that currently tests `requeueTicket` — find it: `grep -rln requeueTicket tests/`)

**Interfaces:**

- Produces:

```ts
export function requeueTicketKeepBudget(
  cfg: Config,
  claimedPath: string,
  notBeforeIso: string,
  reason: string,
): { requeued: true; dst: string };
```

- Refactor: extract the atomic write+move+collision-suffix block of `requeueTicket` (current lines 99-119: tmp+rename in place, inbox mkdir, `CLAIM_PREFIX_RE` strip, `-r{n}` collision loop, rename into inbox) into a module-private helper `moveBackToInbox(cfg, claimedPath, content, suffixSeed: number): string` used by BOTH functions. `requeueTicket`'s observable behavior must not change (its existing tests are the regression net).

Semantics of the new function (each is a test):

- Stamps `not_before: "<iso>"` ONLY — `retry_count` line is left exactly as-is (absent stays absent; an existing value is preserved verbatim).
- No budget check — always requeues (the GATE is what prevents a hot loop, not the budget; a gate-class failure must never consume attempts).
- Malformed frontmatter: best-effort — if the re-parse shows `not_before` did not persist, log a warning and requeue anyway (unlike `requeueTicket`'s decline: a budget-burning hot loop is impossible here because claiming is gated).
- Calls `metrics.recordRequeue()` (the chokepoint comment at `src/requeue.ts:120-123` says every requeue path funnels through it — keep that true) and logs with a distinct message (`"infrastructure failure — requeued without consuming retry budget"`).

- [ ] **Step 1: Failing tests** (new describe in the existing requeue test file, reusing its tmp-queue fixture helpers): count-free stamp; retry_count preserved verbatim when present; requeues even at exhausted budget (`retry_count: 99`); collision suffix works; `requeueTicket` regression suite still green.

- [ ] **Step 2: Run** — FAIL (export missing).

- [ ] **Step 3: Implement** (extract helper + new function per semantics).

- [ ] **Step 4: Run** requeue tests + full suite — PASS.

- [ ] **Step 5: Commit** `feat(requeue): requeueTicketKeepBudget — count-free not_before requeue for gate-class failures`

---

### Task 5: wire classification + gate into `runOnce` (Q&A + crash paths)

**Files:**

- Modify: `src/runOnce.ts` (deps interface ~line 60-79; Q&A failure site ~line 326-339; crash containment ~line 343-368)
- Test: `tests/runOnce.test.ts`

**Interfaces:**

- `RunOnceDeps` gains:

```ts
  /** Provider gate — classification-driven claim pausing. Optional: absent
   * (CLI one-shot, tests) preserves pre-gate behavior exactly. */
  gate?: Pick<ProviderGate, "reportFailure" | "reportSuccess" | "notBeforeIso">;
```

(import `ProviderGate` type-only; also import `classifyProviderFailure` and `requeueTicketKeepBudget`.)

- Q&A failure site — replace the current block at ~line 326:

```ts
// Infrastructure failures (bad key, quota, 429, model typo) are not the
// ticket's fault: report to the gate (pauses claiming) and requeue
// WITHOUT consuming the retry budget. Only zero-commit runs — Q&A never
// commits. Transient (outage/unknown) failures keep the budgeted path.
const cls = classifyProviderFailure(result.errorMessage);
if (deps.gate && GATE_CLASSES.has(cls)) {
  deps.gate.reportFailure(cls, result.errorMessage ?? cls);
  const rq = requeueTicketKeepBudget(
    cfg,
    claimed,
    deps.gate.notBeforeIso(),
    result.errorMessage ?? cls,
  );
  await reporter.onRequeue(next).catch(() => undefined);
  log.warn("provider-gate requeue", { dst: rq.dst, class: cls });
  return;
}
if (deps.gate && cls === "outage") deps.gate.reportFailure(cls, result.errorMessage ?? cls);
if (isTransientFailure(result, 0)) {
  /* existing requeueTicket block unchanged */
}
if (deps.gate && result.errorMessage === null && !result.timedOut && !result.abortedByGuard) {
  deps.gate.reportSuccess();
}
```

with `const GATE_CLASSES: ReadonlySet<ProviderFailureClass> = new Set(["auth", "quota", "rate_limit", "model_not_found"]);` at module scope. NOTE the placement: `reportSuccess` must run before finalize-to-done as well as after a clean run — put the success call immediately before the `finalize(...)` call, guarded as shown.

- Crash containment site (~line 352): classify the thrown `reason` the same way BEFORE the existing `requeueTicket` attempt. This is the path where the catalog-miss/null-key session-build throw lands (`resolveModelViaRegistries`'s "did not resolve from the builtin catalog" error) — it must classify as gate-class-or-unknown and, when gate-class, use the count-free requeue + `gate.reportFailure`. The factory's model-not-in-registry and null-key errors: add `did not resolve from the builtin catalog|not found in registry` to the `MODEL_NOT_FOUND` regex in Task 1 IF the classifier misses them — write the test first (see Step 1) and extend the regex in `src/providerFailure.ts` in this task if needed (note it in the commit body).

- [ ] **Step 1: Failing tests** in `tests/runOnce.test.ts` (reuse its fake-session/fixture harness):
  1. Q&A run whose fake session errors with `"401 invalid x-api-key"` + a fake `gate` (record calls) → ticket back in `inbox/` with `not_before` stamped and `retry_count` ABSENT/unchanged; `gate.reportFailure("auth", …)` called; reporter.onRequeue called.
  2. Same with `"429 rate limited"` → `reportFailure("rate_limit", …)`, count-free requeue.
  3. Session factory that REJECTS with `new Error('model "anthropic/nope": provider "anthropic" did not resolve from the builtin catalog and no inline endpoint is configured — …')` → crash path classifies `model_not_found` → `reportFailure("model_not_found", …)` + count-free requeue (retry_count unchanged).
  4. Errored run with plain text (`"agent gave up"`) and a gate present → existing budgeted `requeueTicket` path used (retry_count = 1), gate NOT latched (no reportFailure with a latch class; outage/unknown per classifier).
  5. Successful run with gate present → `gate.reportSuccess()` called once.
  6. NO gate in deps → behavior byte-identical to today (existing tests are the net; add one explicit 401-without-gate case asserting the budgeted path).

- [ ] **Step 2: Run** — new tests FAIL.

- [ ] **Step 3: Implement** per the blocks above.

- [ ] **Step 4: Run** `npx vitest run tests/runOnce.test.ts` then full suite — PASS.

- [ ] **Step 5: Commit** `feat(gate): classify + gate-route Q&A and crash failures in runOnce`

---

### Task 6: wire classification + gate into `prFlow` (both zero-commit sites)

**Files:**

- Modify: `src/prFlow.ts` (deps interface; sites ~line 480 and ~line 568 — locate by the `isTransientFailure(result, commitsSoFar)` and `stop_reason=${result.stopReason}` calls)
- Modify: `src/runOnce.ts` (pass `gate` through into the `runPrFlow` deps at ~line 271)
- Test: `tests/prFlow.test.ts`

**Interfaces:** `runPrFlow`'s deps gain the same optional `gate` pick as Task 5. Rules:

- Gate-class routing ONLY when `commitsSoFar === 0` (committed work is never discarded — same invariant as `isTransientFailure`). Site ~480 has `commitsSoFar`; site ~568 is already zero-commit by construction (verify the surrounding guard when editing).
- `outage` reports to the gate (non-latching) on both sites; budgeted requeue behavior unchanged.
- `reportSuccess()` on the PR-flow success path (where the flow finalizes to done with a PR or clean completion — one call site, guarded on gate presence).
- No gate in deps → byte-identical behavior.

- [ ] **Step 1: Failing tests** in `tests/prFlow.test.ts` (its git-harness + fake-session patterns): zero-commit 401 → count-free requeue + `reportFailure("auth")`; zero-commit 429 at the stop_reason site → same with `rate_limit`; WITH commits + 401 → gate NOT consulted for requeue (existing salvage path untouched — assert the PR/salvage behavior the file already pins); success → `reportSuccess()`.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement**; thread `gate: deps.gate` from `runOnce` into the `runPrFlow` call.

- [ ] **Step 4: Run** prFlow + runOnce + full suite — PASS.

- [ ] **Step 5: Commit** `feat(gate): classify + gate-route zero-commit PR-flow failures`

---

### Task 7: probe policy lever + TTL probe cache

**Files:**

- Modify: `src/config.ts` (worker schema + assembly), `src/types.ts` (Config), `src/configLevers.ts` (lever — the bijection test forces this in the same commit)
- Modify: `src/health.ts` (`endpointReachable`, `waitForEndpoint`, new `makeCachedProbe`)
- Test: `tests/config.test.ts`, `tests/configLevers.test.ts`, `tests/health.test.ts` + fixture sweep

**Interfaces:**

- Schema: `worker.endpointProbe: z.enum(["auto", "always", "never"]).default("auto")`; flat `Config.endpointProbe: "auto" | "always" | "never"`; lever `worker.endpointProbe` (`reload: "live"`, default `"auto"`, description: `"Endpoint probe policy: auto (probe local/inline, skip hosted catalog), always, or never."`).
- `src/health.ts`:

```ts
/** TTL-cached, in-flight-deduplicated wrapper around a boolean probe. One
 * instance is shared by the claim gate, /health, and /ready so the dashboard's
 * poll cadence can't multiply upstream probe traffic. */
export function makeCachedProbe(
  probe: () => Promise<boolean>,
  ttlMs = 10_000,
  now: () => number = Date.now,
): () => Promise<boolean>;
```

- `endpointReachable`/`waitForEndpoint` policy: replace the Phase-1 `if (!shouldProbeEndpoint(cfg.model)) return true;` guards with a three-way `probePolicy(cfg)`: `"never"` → skip (return true / early-return); `"always"` → probe; `"auto"` → current `shouldProbeEndpoint(cfg.model)` predicate. Export `probePolicy(cfg: Config): boolean` ("should we probe") from `health.ts` for doctor reuse (doctor's Phase-1 guard switches to it — one-line change in `src/doctor.ts`).

- [ ] **Step 1: Failing tests**: config defaults/parse for `endpointProbe`; lever pin; `makeCachedProbe` — second call within TTL does not re-invoke (fake clock), expiry re-invokes, concurrent calls share one in-flight promise (probe resolves via a deferred; call twice before resolving; assert probe invoked once); `endpointReachable` with `endpointProbe: "never"` on a LOCAL config → true without fetch; `"always"` on a hosted-catalog config → fetch attempted.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement**; sweep fixtures for the new required `Config.endpointProbe` field (add `endpointProbe: "auto"` to every flagged `makeConfig`; `npm run typecheck` finds them all).

- [ ] **Step 4: Run** touched suites + full suite — PASS.

- [ ] **Step 5: Commit** `feat(health): worker.endpointProbe policy lever + TTL-cached probe`

---

### Task 8: metrics — gate transition counters

**Files:**

- Modify: `src/metrics.ts` (follow the `recordRequeue`/`_requeues` pattern: ~lines 87, 153, 276, 308)
- Test: `tests/metrics.test.ts` (or wherever `recordRequeue` is tested — grep)

**Interfaces:**

- `recordGateTransition(to: string): void`; snapshot gains `gateTransitions: Record<string, number>` (state name → count of entries into that state); reset clears it. Keep it dumb — the gate itself stays metrics-free.

- [ ] Steps: failing test (record two `auth_error` + one `ok` → snapshot `{ auth_error: 2, ok: 1 }`; reset clears) → implement → green → commit `feat(metrics): gate transition counters`.

---

### Task 9: health server — gate status in `/health` and `/ready`

**Files:**

- Modify: `src/healthServer.ts` (options ~line 20-40; handler ~line 109-127)
- Test: `tests/healthServer.test.ts`

**Interfaces:**

- Options gain `gateStatus?: () => GateStatus` (import type from `providerGate.js`). `/health` JSON gains `gate: gateStatus?.() ?? null`. `/ready` 503 body becomes `{ status: "not_ready", reason: <gate reason when gate non-ok, else "dependency unreachable"> }` — when the gate is non-ok, `/ready` is 503 even if the probe passes (a latched auth error means work cannot be served).

- [ ] Steps: failing tests (gate ok + probe true → 200 with `gate.state === "ok"` in /health; gate `auth_error` → /ready 503 with the gate's reason; no gateStatus option → `/health.gate === null`, /ready behavior unchanged) → implement → green → commit `feat(health): surface provider-gate state in /health and /ready`.

---

### Task 10: daemon wiring — one gate, one cached probe, hot-reload clear

**Files:**

- Modify: `src/daemon.ts` (probe/readyFn sites at ~lines 411-419, 461, 480; watcher startup site — grep `watchConfig(`)
- Modify: `src/configWatcher.ts` (deps gain `onApplied?: () => void`, called right after `holder.current = nextConfig;` at ~line 99)
- Test: `tests/daemon.test.ts`, `tests/configWatcher.test.ts`

**Wiring (all inside `runDaemon`, near the existing `runOnceFn` default at ~line 411):**

```ts
const gate =
  deps.gate ??
  new ProviderGate({
    retryBackoffSeconds: cfg.retryBackoffSeconds,
    onTransition: (_from, to) => metrics.recordGateTransition(to),
  });
const cachedReachable = makeCachedProbe(() => endpointReachable(activeCfg()));
const gatedReady = async (): Promise<boolean> => {
  const block = gate.claimBlockReason();
  if (block) {
    log.warn("claiming paused by provider gate", { reason: block });
    return false;
  }
  return cachedReachable();
};
```

- `runOnce` default deps: `readyFn: gatedReady, gate` (serial site ~416); scheduler `readyFn: gatedReady` + thread `gate` into its executeFn→runOnce path (follow how `reporter` is threaded); health server: `readinessProbe: cachedReachable, gateStatus: () => gate.status()`.
- `DaemonDeps` gains `gate?: ProviderGate` (tests inject fakes).
- Watcher: `onApplied: () => gate.clearLatched()` at the `watchConfig` call site; `configWatcher.ts` invokes it after adopting the new config (default no-op).
- NOTE `activeCfg`/`cachedReachable` capture: the cache wraps the _call_, so hot-reloaded config is still picked up on the next uncached probe — no invalidation needed beyond the TTL.

- [ ] **Step 1: Failing tests**: daemon test with injected fake gate whose `claimBlockReason()` returns `"auth_error: bad key"` → poll leaves inbox untouched + warn logged (reuse the file's readyFn-blocked test pattern); configWatcher test → `onApplied` fires after a successful reload, NOT after a failed one (throwing assembleFn — reuse the Phase-1 regression test's harness).

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4:** daemon + configWatcher + full suite green (remember the real-tick sleep rule). **Step 5: Commit** `feat(daemon): provider gate wired into claim gate, health server, and hot-reload`

---

### Task 11: TUI — gate state on the dashboard

**Files:**

- Modify: `src/tui/localSnapshot.ts` (daemon-detail fetch — it already parses `/health`; pick up the new `gate` field; also wrap its direct probe in `makeCachedProbe`)
- Modify: `src/tui/components/LocalDashboard.tsx` (the daemon status dot region, ~line 416-423)
- Test: `tests/localSnapshotDaemon.test.ts`, `tests/tuiApp.test.tsx` (or the LocalDashboard test file — grep)

**Contract (adapt rendering to the file's existing dot/status idioms):**

- `LocalDaemonDetail` (or equivalent snapshot type) gains `gate: { state: string; reason: string | null; until: string | null } | null` populated from `/health`'s `gate` field (null when absent — older daemon).
- Dot color: green `ok`; yellow `rate_limited`/`outage_backoff`/probe-unreachable; red `auth_error`/`quota_exhausted`/`misconfig`. When non-ok, render one line: state + reason (truncate to the pane width per the file's existing truncation helpers).
- TUI tests: loop-until-condition, never a single fixed tick.

- [ ] Steps: failing tests (snapshot parses `gate` from a fake /health payload; dashboard renders `auth_error` reason line red-dot case and plain `ok` case) → implement → green → commit `feat(tui): provider-gate state + reason on the dashboard`.

---

### Task 12: docs + CHANGELOG (conformance)

**Files:** `CHANGELOG.md`, `docs/operations.md` (gate states + `/health` payload), `docs/tickets.md` (retry semantics: which failures consume the budget and which don't), `docs/configuration.md` (`worker.endpointProbe`).

- Content requirements (every line is a conformance assertion — verify each against the code before committing):
  - The six gate states and what clears each (success / hot-reload / expiry).
  - Infrastructure failures (`auth`/`quota`/`model_not_found`/`rate_limit`) do NOT consume `retry_count`; `outage`/`unknown` keep the budgeted transient path.
  - `worker.endpointProbe` semantics; probes are TTL-cached (~10 s).
  - `/health` gains `gate: {state, reason, since, until}`; `/ready` 503 carries the gate reason.
- [ ] Steps: write → per-claim verification pass → prettier → commit `docs(gate): provider gate states, count-free retries, probe policy`.

---

### Task 13: full gate + PR

- [ ] Full gate: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test > /tmp/gate2.out 2>&1; echo "exit: $?"` → `exit: 0`.
- [ ] Sandboxed smoke (per CLAUDE.md pattern): `init --yes` + `doctor` still clean; plus a curl of `/health` shape is covered by tests — no live daemon run.
- [ ] Push `feat/hosted-providers-phase2`, PR titled `feat: provider gate — failure classification, count-free retries, probe policy (phase 2/3)`, body summarizing the state machine, the count-free requeue invariant, the drift-fix (session-build misconfig now latches instead of burning budget), and the Phase-3 remainder. No AI attribution anywhere; verify `git log origin/main..HEAD --format='%b' | grep -ci "co-authored\|generated with"` → 0.
