# Run Envelope + Transcript Replay Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse junco's five hand-copied `runAgent` wrappers into one `runEnveloped` module that also writes reconstructability records, then add a replay engine + `junco replay` CLI that re-runs recorded transcripts through the guard/supervisor stack under any policy.

**Architecture:** A new `src/agent/runEnvelope.ts` owns GuardManager construction, transcript sink lifecycle (schema-v2 `junco_meta`/`junco_run_start`/`junco_run_end` records), the `runAgent` call, and spend recording; all five flows call it. A pure `src/agent/replay.ts` re-feeds recorded SDK events through a fresh `GuardManager` (synthesizing coarse text deltas from `message_end` messages), mirroring `session.ts`'s kill-gating, and reports recorded-vs-replayed decisions. v1 transcripts (pre-change) stay replayable via `agent_end` run boundaries.

**Tech Stack:** TypeScript strict ESM/NodeNext, Node ≥ 22.19, vitest. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-16-run-envelope-replay-harness-design.md`

## Global Constraints

- Full gate before claiming done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`
- Never pipe vitest into grep/tail; capture exit explicitly: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"`
- Never import the Pi SDK at module top level in `src/` (type-only imports fine); runtime `await import` stays only in `src/agent/session.ts`
- Every side effect behind an injectable `deps` seam; tests never touch network or a real model
- No new `Config` fields are needed by this plan. If you find yourself adding one, stop — re-read the spec. (If one ever is added, it goes in `tests/helpers/config.ts` and nowhere else.)
- `src/ticketSchema.ts` untouched (public contract; nothing here changes tickets)
- Conventional commits (`feat:`/`refactor:`/`docs:`), **no AI attribution trailers of any kind**
- Prettier may reformat between read and edit: re-read before editing, run `npx prettier --write` on touched files before committing
- Exact-pinned deps only (`npm install --save-exact`) — moot here (no new deps)
- Work on branch `feat/run-envelope-replay` in a worktree; the main checkout is the daemon's live build home — never run `junco start` there, never touch `config.json`/`tickets/`/`worktrees/`
- First commit on the branch: this plan + the spec (`docs: run-envelope + replay harness spec and plan`)

## Verified facts the plan relies on (do not re-derive)

- The five wrapper sites: `src/runOnce.ts:400-432` (Q&A), `src/assessFlow.ts:~276-302`, `src/analyzeFlow.ts` (same shape as assessFlow), `src/prFlow.ts:474-509` (main), `src/prFlow.ts:~760-790` (corrective).
- SDK event union (`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:359-399`): `message_end`/`turn_end` carry the full `AgentMessage`; content blocks are `{type:"text", text}` / `{type:"thinking", thinking}` (pi-ai `types.d.ts:222-231`).
- The transcript records every non-delta event (`session.ts:265` skips only `message_update`) plus synthetic `junco_guard_decision` lines (`session.ts:301-313`).
- `GuardManager.observe` consumes `message_start`, `turn_start`, `message_update` (deltas), `tool_execution_start`, `tool_execution_end`, `turn_end`; commit-intent = `bash` tool call whose `args.command` contains `git commit` (`guardManager.ts:234-239`). It ignores `message_end`.
- `session.ts` stops feeding the GuardManager once `killReason !== null` (`session.ts:277`), and a fresh GuardManager is constructed per `runAgent` call at every site.
- `transcriptPathFor(dir, id)` → `join(dir, slugifyId(id) + ".jsonl")` (`src/slug.ts:38`).
- Test fakes: `tests/helpers/fakeSession.ts` (delivery timing is load-bearing — reuse, don't reimplement); `tests/helpers/config.ts` exports `makeConfig` (read it first; override non-seam Config fields by spreading: `{ ...makeConfig(), supervisorBudgetPerKind: 2 }`).

---

### Task 1: `guardOptionsFromConfig` + `buildGuardManager`, migrate all five construction sites

**Files:**
- Create: `src/agent/runEnvelope.ts`
- Test: `tests/runEnvelope.test.ts`
- Modify: `src/runOnce.ts:404-413`, `src/assessFlow.ts:~276-284`, `src/analyzeFlow.ts` (same block), `src/prFlow.ts:474-483`, `src/prFlow.ts:~777-787`

**Interfaces:**
- Produces: `guardOptionsFromConfig(cfg: Config): GuardManagerOptions` and `buildGuardManager(cfg: Config): GuardManager | undefined` — later tasks import both from `./agent/runEnvelope.js`.

- [ ] **Step 1: Read `tests/helpers/config.ts`** to learn `makeConfig`'s seam signature before writing the test.

- [ ] **Step 2: Write the failing test**

```ts
// tests/runEnvelope.test.ts
import { describe, it, expect } from "vitest";
import { guardOptionsFromConfig, buildGuardManager } from "../src/agent/runEnvelope.js";
import { makeConfig } from "./helpers/config.js";

describe("guardOptionsFromConfig", () => {
  it("threads the four supervisor knobs verbatim", () => {
    const cfg = {
      ...makeConfig(),
      supervisorEnabled: true,
      supervisorBudgetPerKind: 2,
      supervisorEscalationWindow: 5,
      supervisorOutputBudgetPerTurn: 9000,
      supervisorOutputBudgetPostCommit: 18000,
    };
    expect(guardOptionsFromConfig(cfg)).toEqual({
      supervisorConfig: { budgetPerKind: 2, escalationWindowTurns: 5 },
      outputBudgetPerTurn: 9000,
      outputBudgetPostCommit: 18000,
    });
  });
});

describe("buildGuardManager", () => {
  it("returns undefined when the supervisor is disabled", () => {
    expect(buildGuardManager({ ...makeConfig(), supervisorEnabled: false })).toBeUndefined();
  });
  it("returns a GuardManager when enabled", () => {
    const gm = buildGuardManager({ ...makeConfig(), supervisorEnabled: true });
    expect(gm).toBeDefined();
    expect(gm!.supervisorSummary).toBe("no nudges issued");
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `npx vitest run tests/runEnvelope.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement**

```ts
// src/agent/runEnvelope.ts
/**
 * runEnvelope — the single wrapper every junco agent run goes through.
 *
 * Grows over this plan into: guard construction (this task), transcript
 * lifecycle + junco_run records, the runAgent call, and spend recording —
 * replacing the five hand-copied wrappers (runOnce Q&A, assessFlow,
 * analyzeFlow, prFlow main, prFlow corrective) whose parity previously
 * rested on comments (#180.3).
 */
import type { Config } from "../types.js";
import { GuardManager, type GuardManagerOptions } from "./guardManager.js";

/** The four supervisor knobs, mapped verbatim — one site instead of five. */
export function guardOptionsFromConfig(cfg: Config): GuardManagerOptions {
  return {
    supervisorConfig: {
      budgetPerKind: cfg.supervisorBudgetPerKind,
      escalationWindowTurns: cfg.supervisorEscalationWindow,
    },
    outputBudgetPerTurn: cfg.supervisorOutputBudgetPerTurn,
    outputBudgetPostCommit: cfg.supervisorOutputBudgetPostCommit,
  };
}

export function buildGuardManager(cfg: Config): GuardManager | undefined {
  return cfg.supervisorEnabled ? new GuardManager(guardOptionsFromConfig(cfg)) : undefined;
}
```

- [ ] **Step 5: Run to verify it passes**, then commit: `feat(agent): guardOptionsFromConfig + buildGuardManager in runEnvelope`

- [ ] **Step 6: Migrate the five construction sites.** At each site listed above, replace the whole `const guardManager = cfg.supervisorEnabled ? new GuardManager({...}) : undefined;` block with `const guardManager = buildGuardManager(cfg);` (prFlow corrective builds inline inside the `runAgent` call — replace the ternary expression with `buildGuardManager(cfg)`). Delete now-unused `GuardManager` imports. Note: in prFlow, `flowCfg` differs from `cfg` only in `tools`, so `buildGuardManager(cfg)` and `buildGuardManager(flowCfg)` are equivalent — use the variable the surrounding code already holds.

- [ ] **Step 7: Full suite green** (`npx vitest run > /tmp/out 2>&1; echo "exit: $?"`), prettier touched files, commit: `refactor: all guard-manager construction through buildGuardManager`

---

### Task 2: `transcriptSchema.ts` — v2 record types + line parser

**Files:**
- Create: `src/agent/transcriptSchema.ts`
- Test: `tests/transcriptSchema.test.ts`

**Interfaces:**
- Produces (imported by Tasks 4, 8, 10):

```ts
export const TRANSCRIPT_VERSION = 2;
export type FlowKind = "qa" | "plan" | "pr" | "pr_corrective" | "assess" | "analyze";
export interface MetaRecord { type: "junco_meta"; version: number; ticketId: string; createdAt: string; }
export interface RunStartRecord {
  type: "junco_run_start"; flow: FlowKind; body: string; cwd: string;
  modelId: string; tools: string[]; timeoutMs: number;
  guard: { enabled: boolean } & GuardManagerOptions; ts: string;
}
export interface RunEndRecord {
  type: "junco_run_end"; errorMessage: string | null; stopReason: string | null;
  timedOut: boolean; abortedByGuard: boolean;
  usage: Usage; durationMs: number; ts: string;
}
export interface GuardDecisionRecord {
  type: "junco_guard_decision"; kind: string; action: "nudge" | "kill";
  detail: string; turnIndex: number; nudgeMessage?: string; reason?: string; ts: string;
}
export type JuncoRecord = MetaRecord | RunStartRecord | RunEndRecord | GuardDecisionRecord;
export type ParsedLine =
  | { kind: "junco"; record: JuncoRecord }
  | { kind: "sdk"; event: Record<string, unknown> }
  | { kind: "invalid"; raw: string };
export function parseTranscriptLine(line: string): ParsedLine;
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/transcriptSchema.test.ts
import { describe, it, expect } from "vitest";
import { parseTranscriptLine } from "../src/agent/transcriptSchema.js";

describe("parseTranscriptLine", () => {
  it("classifies junco_* records", () => {
    const p = parseTranscriptLine(
      JSON.stringify({ type: "junco_guard_decision", kind: "tool_call_loop", action: "nudge", detail: "d", turnIndex: 3, ts: "t" }),
    );
    expect(p.kind).toBe("junco");
    if (p.kind === "junco") expect(p.record.type).toBe("junco_guard_decision");
  });
  it("classifies SDK events", () => {
    const p = parseTranscriptLine(JSON.stringify({ type: "turn_end", message: {} }));
    expect(p.kind).toBe("sdk");
  });
  it("tolerates a truncated line (crash mid-write) as invalid", () => {
    expect(parseTranscriptLine('{"type":"turn_en').kind).toBe("invalid");
  });
  it("tolerates a junco-prefixed but unknown type as sdk passthrough", () => {
    // Forward compat: an older junco reading a newer transcript must not throw.
    expect(parseTranscriptLine(JSON.stringify({ type: "junco_future_thing" })).kind).toBe("junco");
  });
});
```

- [ ] **Step 2: Run to verify it fails**, then implement. Parser body: `JSON.parse` in try/catch → `invalid` on throw or non-object; `kind: "junco"` when `typeof obj.type === "string" && obj.type.startsWith("junco_")` (cast to `JuncoRecord` — consumers switch on `.type` and default-ignore unknowns); else `sdk`. `Usage` type comes from `../types.js`; `GuardManagerOptions` from `./guardManager.js` (both type-only — keeps this module SDK-free and pure).

- [ ] **Step 3: Run to verify it passes**, full suite, prettier, commit: `feat(agent): transcript schema v2 types + line parser`

---

### Task 3: `runAgent` accepts a caller-owned transcript sink

**Files:**
- Modify: `src/agent/session.ts` (`RunAgentOptions`, sink setup ~lines 246-253, and the `finally` at ~line 355)
- Test: extend `tests/session.test.ts`

**Interfaces:**
- Produces: `RunAgentOptions.transcript?: TranscriptSink | null` — caller-owned open sink; when set, it wins over `transcriptPath` and `runAgent` never calls `end()` on it. (`transcriptPath`/`transcriptSink` remain until Task 7 removes them.)

- [ ] **Step 1: Write the failing tests** (in `tests/session.test.ts`, using its existing fake-session patterns — read the file's existing transcript tests first and mirror their style):

```ts
it("writes events to a caller-owned transcript sink and does not end it", async () => {
  const lines: string[] = [];
  let ended = false;
  const sink = { write: (l: string) => lines.push(l), end: () => { ended = true; } };
  await runAgent({
    body: "go", cwd: "/x", timeoutMs: 5000,
    createSession: fakeSession("hello"),
    transcript: sink,
  });
  expect(lines.some((l) => l.includes('"turn_end"'))).toBe(true);
  expect(lines.some((l) => l.includes("message_update"))).toBe(false); // deltas still skipped
  expect(ended).toBe(false); // caller owns lifecycle
});

it("prefers the caller-owned sink over transcriptPath", async () => {
  const lines: string[] = [];
  const factoryCalls: string[] = [];
  await runAgent({
    body: "go", cwd: "/x", timeoutMs: 5000,
    createSession: fakeSession("hello"),
    transcript: { write: (l: string) => lines.push(l), end: () => {} },
    transcriptPath: "/sbxroot/never.jsonl",
    transcriptSink: (p) => { factoryCalls.push(p); return null; },
  });
  expect(lines.length).toBeGreaterThan(0);
  expect(factoryCalls).toEqual([]); // path branch never taken
});
```

- [ ] **Step 2: Run to verify they fail**, then implement in `session.ts`:

```ts
// RunAgentOptions addition:
  /**
   * Caller-owned, already-open transcript sink (the run envelope). When set it
   * wins over transcriptPath, and runAgent never end()s it — the caller writes
   * its own junco_run_start/run_end frame around this run's events.
   */
  transcript?: TranscriptSink | null;
```

Sink setup becomes:

```ts
  let transcript: TranscriptSink | null = null;
  let ownsTranscript = false;
  if (opts.transcript !== undefined) {
    transcript = opts.transcript;
  } else if (opts.transcriptPath) {
    transcript = (opts.transcriptSink ?? defaultTranscriptSink)(opts.transcriptPath);
    ownsTranscript = true;
  }
```

And in the `finally`: `if (ownsTranscript) transcript?.end();`

- [ ] **Step 3: Tests pass, full suite green**, prettier, commit: `feat(agent): runAgent accepts caller-owned transcript sink`

---

### Task 4: `openTicketTranscript` + `runEnveloped`

**Files:**
- Modify: `src/agent/runEnvelope.ts`
- Test: `tests/runEnvelope.test.ts`
- Docs: `ARCHITECTURE.md` (add `runEnvelope.ts` + `transcriptSchema.ts` rows to the module table; update the `session.ts` row's transcript sentence)

**Interfaces:**
- Consumes: `buildGuardManager`/`guardOptionsFromConfig` (Task 1), schema types (Task 2), `runAgent` + `TranscriptSink`/`TranscriptSinkFactory`/`AgentSessionLike` from `./session.js`, `RunResult` from `../types.js`, `transcriptPathFor` from `../slug.js`, `dataTreePaths` from `../dataTree.js`, `GuardDecision` from `./guardManager.js`.
- Produces (the seam every flow migrates onto in Tasks 5-7):

```ts
export interface EnvelopeSpec {
  ticketId: string; flow: FlowKind; body: string; cwd: string; timeoutMs: number;
}
export interface EnvelopeDeps {
  createSession: () => Promise<AgentSessionLike>;
  abortSignal?: AbortSignal;
  onProgress?: (p: { turns: number; lastTool: string | null; outputTokens: number }) => void;
  onGuardDecision?: (d: GuardDecision) => void;
  spend?: { recordUsd(usd: number): void };
  /** Injectable fs seams (tests); default to real fs. */
  transcriptSink?: TranscriptSinkFactory;
  fileExists?: (path: string) => boolean;
}
export function openTicketTranscript(
  path: string,
  factory: TranscriptSinkFactory,
  fileExists: (p: string) => boolean,
): { sink: TranscriptSink | null; created: boolean };
export async function runEnveloped(
  cfg: Config, spec: EnvelopeSpec, deps: EnvelopeDeps,
): Promise<RunResult>;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { runEnveloped } from "../src/agent/runEnvelope.js";
import { fakeSession } from "./helpers/fakeSession.js";
import { parseTranscriptLine } from "../src/agent/transcriptSchema.js";

function memorySink(lines: string[]) {
  let ended = false;
  return {
    factory: () => ({ write: (l: string) => lines.push(l), end: () => { ended = true; } }),
    wasEnded: () => ended,
  };
}

describe("runEnveloped", () => {
  const cfg = () => ({ ...makeConfig(), transcriptsEnabled: true, supervisorEnabled: true });

  it("frames the run: meta (new file) + run_start, events, run_end; ends the sink; records spend", async () => {
    const lines: string[] = [];
    const sink = memorySink(lines);
    const spent: number[] = [];
    const result = await runEnveloped(
      cfg(),
      { ticketId: "t-1", flow: "qa", body: "answer me", cwd: "/w", timeoutMs: 5000 },
      {
        createSession: fakeSession("hi", 0.25),
        spend: { recordUsd: (n) => spent.push(n) },
        transcriptSink: sink.factory,
        fileExists: () => false,
      },
    );
    expect(result.finalText).toBe("hi");
    const parsed = lines.map((l) => parseTranscriptLine(l.trimEnd()));
    const types = parsed.map((p) => (p.kind === "junco" ? p.record.type : (p as any).event?.type));
    expect(types[0]).toBe("junco_meta");
    expect(types[1]).toBe("junco_run_start");
    expect(types[types.length - 1]).toBe("junco_run_end");
    expect(types).toContain("turn_end");
    const start = parsed[1] as any;
    expect(start.record.body).toBe("answer me");
    expect(start.record.flow).toBe("qa");
    expect(spent).toEqual([0.25]);
    expect(sink.wasEnded()).toBe(true);
  });

  it("skips the meta record when the file already exists (corrective appends)", async () => {
    const lines: string[] = [];
    await runEnveloped(
      cfg(),
      { ticketId: "t-1", flow: "pr_corrective", body: "fix", cwd: "/w", timeoutMs: 5000 },
      { createSession: fakeSession("ok"), transcriptSink: memorySink(lines).factory, fileExists: () => true },
    );
    expect(lines[0]).toContain("junco_run_start");
  });

  it("never leaks the api key into any transcript line", async () => {
    const lines: string[] = [];
    const c = { ...cfg(), model: { ...cfg().model, apiKey: "sk-SUPER-SECRET" } };
    await runEnveloped(
      c,
      { ticketId: "t-1", flow: "qa", body: "q", cwd: "/w", timeoutMs: 5000 },
      { createSession: fakeSession("a"), transcriptSink: memorySink(lines).factory, fileExists: () => false },
    );
    expect(lines.join("")).not.toContain("sk-SUPER-SECRET");
  });

  it("writes no records when transcripts are disabled, but still runs and records spend", async () => {
    const lines: string[] = [];
    const spent: number[] = [];
    const r = await runEnveloped(
      { ...cfg(), transcriptsEnabled: false },
      { ticketId: "t-1", flow: "qa", body: "q", cwd: "/w", timeoutMs: 5000 },
      {
        createSession: fakeSession("a", 0.1),
        spend: { recordUsd: (n) => spent.push(n) },
        transcriptSink: memorySink(lines).factory,
        fileExists: () => false,
      },
    );
    expect(r.finalText).toBe("a");
    expect(lines).toEqual([]);
    expect(spent).toEqual([0.1]);
  });
});
```

(Check `makeConfig()`'s model shape in the helper before writing the apiKey test — adjust the spread to the real `Config["model"]` type.)

- [ ] **Step 2: Run to verify they fail**, then implement:

```ts
export function openTicketTranscript(
  path: string,
  factory: TranscriptSinkFactory,
  fileExists: (p: string) => boolean,
): { sink: TranscriptSink | null; created: boolean } {
  const created = !fileExists(path);
  return { sink: factory(path), created };
}

export async function runEnveloped(
  cfg: Config,
  spec: EnvelopeSpec,
  deps: EnvelopeDeps,
): Promise<RunResult> {
  const guardManager = buildGuardManager(cfg);
  let sink: TranscriptSink | null = null;
  if (cfg.transcriptsEnabled) {
    const path = transcriptPathFor(dataTreePaths(cfg).transcripts, spec.ticketId);
    const opened = openTicketTranscript(
      path,
      deps.transcriptSink ?? defaultTranscriptSink,
      deps.fileExists ?? existsSync,
    );
    sink = opened.sink;
    if (sink && opened.created) {
      sink.write(
        JSON.stringify({
          type: "junco_meta",
          version: TRANSCRIPT_VERSION,
          ticketId: spec.ticketId,
          createdAt: new Date().toISOString(),
        } satisfies MetaRecord) + "\n",
      );
    }
    // Reconstructability (spec 1b): modelId is a STRING on purpose — never
    // serialize cfg.model (it can carry apiKey).
    sink?.write(
      JSON.stringify({
        type: "junco_run_start",
        flow: spec.flow,
        body: spec.body,
        cwd: spec.cwd,
        modelId: cfg.model.id,
        tools: cfg.tools,
        timeoutMs: spec.timeoutMs,
        guard: { enabled: cfg.supervisorEnabled, ...guardOptionsFromConfig(cfg) },
        ts: new Date().toISOString(),
      } satisfies RunStartRecord) + "\n",
    );
  }
  const start = Date.now();
  try {
    const result = await runAgent({
      body: spec.body,
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
      createSession: deps.createSession,
      guardManager,
      abortSignal: deps.abortSignal,
      onProgress: deps.onProgress,
      onGuardDecision: deps.onGuardDecision,
      transcript: sink,
    });
    // Spend BEFORE any caller branching — parity with every migrated site
    // ("the dollars were spent regardless of what the ticket does next").
    deps.spend?.recordUsd(result.usage.costUsd);
    sink?.write(
      JSON.stringify({
        type: "junco_run_end",
        errorMessage: result.errorMessage,
        stopReason: result.stopReason,
        timedOut: result.timedOut,
        abortedByGuard: result.abortedByGuard,
        usage: result.usage,
        durationMs: result.durationMs,
        ts: new Date().toISOString(),
      } satisfies RunEndRecord) + "\n",
    );
    return result;
  } catch (e) {
    // A rejecting session factory throws before/inside runAgent; the frame
    // still gets a run_end so replay sees the boundary. Rethrow unchanged —
    // crash containment stays the callers' business (runOnce.ts top-level).
    sink?.write(
      JSON.stringify({
        type: "junco_run_end",
        errorMessage: e instanceof Error ? e.message : String(e),
        stopReason: null,
        timedOut: false,
        abortedByGuard: false,
        usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
        durationMs: Date.now() - start,
        ts: new Date().toISOString(),
      } satisfies RunEndRecord) + "\n",
    );
    throw e;
  } finally {
    sink?.end();
  }
}
```

Imports to add: `existsSync` from `node:fs`; `defaultTranscriptSink`, `runAgent`, types from `./session.js`; `TRANSCRIPT_VERSION`, record types from `./transcriptSchema.js`; `transcriptPathFor` from `../slug.js`; `dataTreePaths` from `../dataTree.js`.

- [ ] **Step 3: Tests pass, full suite green.**

- [ ] **Step 4: Add the ARCHITECTURE.md module-table rows** for `runEnvelope.ts` and `transcriptSchema.ts` (one row each, matching the table's terse style), and amend the `session.ts` row: transcript sink may now be caller-owned.

- [ ] **Step 5: Prettier, commit:** `feat(agent): runEnveloped — single wrapper with v2 transcript framing`

---

### Task 5: Migrate the runOnce Q&A site

**Files:**
- Modify: `src/runOnce.ts:400-432` (the `factory`/`guardManager`/`runAgent`/spend block)
- Test: `tests/runOnce.test.ts` (existing tests are the net; add one assertion-level test only if a fake-session test observes transcripts here — check first)

**Interfaces:**
- Consumes: `runEnveloped(cfg, spec, deps)` from `./agent/runEnvelope.js`.

- [ ] **Step 1: Replace the block.** Current shape (verified): builds `qaCfg`, `factory`, `guardManager`, calls `runAgent({... transcriptPath ...})`, then `deps.spend?.recordUsd(...)`. New shape:

```ts
      const qaCfg: Config = { ...cfg, tools: qaTools, model: qaModel };
      const factory = (deps.sessionFactoryFor ?? makePiSessionFactory)(qaCfg, cwd);
      const result = await runEnveloped(
        qaCfg,
        {
          ticketId: next.id,
          flow: next.github?.kind === "plan" ? "plan" : "qa",
          body: next.body,
          cwd,
          timeoutMs: next.timeoutSeconds * 1000,
        },
        {
          createSession: factory,
          abortSignal: deps.abortSignal,
          onProgress: (p) => metrics.setTaskProgress(next.id, p),
          onGuardDecision: (d) => metrics.recordGuardDecision(d.action),
          spend: deps.spend,
        },
      );
```

Delete: the local `guardManager` construction, the `transcriptPath` option, and the now-redundant `deps.spend?.recordUsd(result.usage.costUsd);` line below (the envelope records it — keep the explanatory comment, moved onto the envelope call). NOTE: `qaCfg` (not `cfg`) goes to the envelope so `run_start` records the planner model + narrowed tools. Remove imports that become unused (`GuardManager` was removed in Task 1; now possibly `transcriptPathFor`/`dataTreePaths`/`runAgent` — only if unused elsewhere in the file).

- [ ] **Step 2: Full suite green** — pay attention to `tests/runOnce.test.ts` transcript/spend assertions; behavior must be identical except transcripts now carry the three junco frame records. If a test asserts exact line sequences, update it to skip `junco_meta`/`junco_run_start`/`junco_run_end` (or assert them — better).

- [ ] **Step 3: Prettier, commit:** `refactor(runOnce): Q&A path through runEnveloped`

---

### Task 6: Migrate assessFlow and analyzeFlow

**Files:**
- Modify: `src/assessFlow.ts:~276-302`, `src/analyzeFlow.ts` (its identical block)
- Test: existing `tests/assessFlow.test.ts` / `tests/analyzeFlow.test.ts` are the net

- [ ] **Step 1: assessFlow.** Same mechanical transform as Task 5: replace `guardManager` + `runAgent({... transcriptPath ...})` + `deps.spend?.recordUsd(...)` with `runEnveloped(cfg, { ticketId: ticket.id, flow: "assess", body: ticket.body, cwd: repoPath, timeoutMs: ticket.timeoutSeconds * 1000 }, { createSession: factory, abortSignal: deps.abortSignal, onProgress: deps.onProgress, onGuardDecision: deps.onGuardDecision, spend: deps.spend })`. Keep the variable name `agentResult`.

- [ ] **Step 2: Suite green for `npx vitest run tests/assessFlow.test.ts`**, then full suite. Commit: `refactor(assessFlow): through runEnveloped`

- [ ] **Step 3: analyzeFlow — same transform** with `flow: "analyze"`. Suite, prettier, commit: `refactor(analyzeFlow): through runEnveloped`

---

### Task 7: Migrate prFlow (main + corrective), retire the legacy transcript options

**Files:**
- Modify: `src/prFlow.ts:474-509` (main), `src/prFlow.ts:~760-790` (corrective), then `src/agent/session.ts` (remove `transcriptPath`/`transcriptSink` from `RunAgentOptions`)
- Test: existing `tests/prFlow.test.ts` + `tests/session.test.ts`

- [ ] **Step 1: prFlow main run.** Replace the verified block (guardManager ternary, `transcriptPath` const, `runAgent` call, spend line) with:

```ts
  const flowCfg: Config = task.tools ? { ...cfg, tools: task.tools } : cfg;
  const factory = (deps.sessionFactoryFor ?? makePiSessionFactory)(flowCfg, wtPath, {
    network: task.network ?? undefined,
  });
  const result = await runEnveloped(
    flowCfg,
    { ticketId: task.id, flow: "pr", body: prompt, cwd: wtPath, timeoutMs: task.timeoutSeconds * 1000 },
    {
      createSession: factory,
      abortSignal: deps.abortSignal,
      onProgress: deps.onProgress,
      onGuardDecision: deps.onGuardDecision,
      spend: deps.spend,
    },
  );
```

The `transcriptPath` const also feeds the corrective turn (`session appends to one file`) — with the envelope deriving the path from `task.id` both times, appending to one file is preserved (same path, `fileExists` now true → no second meta). Delete the const.

- [ ] **Step 2: prFlow corrective.** Same transform with `flow: "pr_corrective"`, `body: buildCorrectivePrompt(task, critic.findings)`, cfg `flowCfg` (it's in scope), and keep `extraUsages.push(corrective.usage)`; delete its local spend line (envelope records it).

- [ ] **Step 3: Full suite green.** Commit: `refactor(prFlow): main + corrective runs through runEnveloped`

- [ ] **Step 4: Retire legacy options.** In `session.ts`, remove the `transcriptPath` and `transcriptSink` options from `RunAgentOptions` (keep the `TranscriptSink`/`TranscriptSinkFactory` types and `defaultTranscriptSink` — the envelope uses them); `transcript?: TranscriptSink | null` is now the only way in, and the `ownsTranscript` branch collapses. First `grep -rn "transcriptPath" src/ tests/` — migrate any straggler (doctor/wizard do not call runAgent with transcripts, but verify). Update `tests/session.test.ts` accordingly.

- [ ] **Step 5: Full gate** (`npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`), commit: `refactor(agent): transcript sink is caller-owned only`

---

### Task 8: Replay engine

**Files:**
- Create: `src/agent/replay.ts`
- Test: `tests/replay.test.ts`
- Docs: ARCHITECTURE.md row

**Interfaces:**
- Consumes: `parseTranscriptLine` + record types (Task 2), `GuardManager`, `GuardManagerOptions`, `GuardDecision` from `./guardManager.js`. Pure module: **no fs, no SDK imports.**
- Produces (Task 10 consumes):

```ts
export interface ReplayedDecision { decision: GuardDecision; lineIndex: number; runIndex: number; }
export interface ReplayRun {
  index: number;
  start?: RunStartRecord;        // v2 only
  end?: RunEndRecord;            // v2 only
  recorded: GuardDecisionRecord[];
  replayed: ReplayedDecision[];
  stoppedAtKill: boolean;
}
export interface ReplayReport {
  version: 1 | 2;                // 2 iff any junco_run_start present
  runs: ReplayRun[];
  invalidLines: number;
  caveats: string[];
  identical: boolean;            // recorded vs replayed match on (action, kind, turnIndex) per run
}
export function replayTranscript(lines: string[], opts: { guard: GuardManagerOptions }): ReplayReport;
```

- [ ] **Step 1: Write the failing tests.** Build recorded streams as arrays of JSON strings — helpers keep them readable:

```ts
const j = (o: unknown) => JSON.stringify(o);
const toolStart = (name: string, args: unknown) => j({ type: "tool_execution_start", toolCallId: "c", toolName: name, args });
const toolEnd = (name: string, isError = false) => j({ type: "tool_execution_end", toolCallId: "c", toolName: name, result: {}, isError });
const turnEnd = (output = 10) => j({ type: "turn_end", message: { role: "assistant", usage: { output } }, toolResults: [] });
const msgStart = () => j({ type: "message_start", message: { role: "assistant", content: [] } });
const msgEnd = (text: string) => j({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
const runStart = (flow = "qa") => j({ type: "junco_run_start", flow, body: "b", cwd: "/w", modelId: "m", tools: [], timeoutMs: 1, guard: { enabled: true }, ts: "t" });
const agentEnd = () => j({ type: "agent_end", messages: [], willRetry: false });
```

Test cases (each is its own `it`):
1. **Tool-loop nudge replays.** Default `ToolCallLoopGuard` threshold: read `src/agent/guards.ts` for the exact repeat count N; feed N identical `toolStart("bash", {command:"ls"})`/`toolEnd("bash")` pairs (plus `turnEnd()`s to advance turns as needed so the trip is realistic). Expect one replayed decision, `action: "nudge"`, `kind: "tool_call_loop"`.
2. **Policy what-if flips a nudge to a kill.** Same stream, `opts.guard.supervisorConfig.budgetPerKind: 0` → expect `action: "kill"` (budget exhausted).
3. **Rep-guard trips from message_end text.** Build `msgStart()` + `msgEnd(repetitiveText)` where `repetitiveText` is a paragraph repeated enough to trip `RepetitionGuard` (read `guards.ts` for `minChars`/repeat thresholds and construct accordingly). Expect a `text_rep` decision — proving v1 transcripts (no deltas) replay rep guards.
4. **Kill gating.** A stream whose first decision is a kill (e.g. output_budget: `turnEnd(999999)` with default budget) followed by more trip-worthy events → exactly one replayed decision; `stoppedAtKill: true`.
5. **v1 multi-run boundary.** Two tool-loop streams separated by `agentEnd()`, no `junco_*` records → `version: 1`, two runs, each with its own decision (GuardManager state reset between).
6. **v2 run boundary + recorded comparison.** `runStart()` + stream + a recorded `junco_guard_decision` line matching the replayed decision + `agentEnd()` → `version: 2`, `identical: true`; change `opts` so replay diverges → `identical: false`, and the recorded line still appears in `runs[0].recorded` (never fed to the GuardManager).
7. **Invalid lines counted, not fatal.** A truncated line mid-stream → `invalidLines: 1`, replay continues.

- [ ] **Step 2: Run to verify they fail**, then implement. Engine skeleton:

```ts
export function replayTranscript(lines, opts): ReplayReport {
  const parsed = lines.map(parseTranscriptLine);
  const version = parsed.some((p) => p.kind === "junco" && p.record.type === "junco_run_start") ? 2 : 1;
  const runs: ReplayRun[] = [];
  let run: ReplayRun | null = null;
  let gm: GuardManager | null = null;
  let killed = false;
  let invalidLines = 0;
  const newRun = (start?: RunStartRecord) => {
    run = { index: runs.length, start, recorded: [], replayed: [], stoppedAtKill: false };
    runs.push(run);
    gm = new GuardManager(opts.guard);
    killed = false;
  };
  for (const [i, p] of parsed.entries()) {
    if (p.kind === "invalid") { invalidLines++; continue; }
    if (p.kind === "junco") {
      switch (p.record.type) {
        case "junco_run_start": newRun(p.record); break;
        case "junco_run_end": if (run) run.end = p.record; break;
        case "junco_guard_decision": if (!run) newRun(); run!.recorded.push(p.record); break;
        // junco_meta and unknown junco_* records: ignore.
      }
      continue;
    }
    // SDK event. v1 files have no run_start records — open an implicit run
    // lazily on the first event (and again after each agent_end boundary).
    if (!run) newRun();
    const ev = p.event;
    // v1 boundary: agent_end closes the run (live semantics: fresh GuardManager per runAgent call).
    if (ev.type === "agent_end") { if (version === 1) run = null; continue; }
    if (killed || !gm) continue; // mirror session.ts's killReason gate
    // Rep-guard input synthesis: message_end carries the full assistant message.
    if (ev.type === "message_end") {
      const msg = ev.message as { role?: string; content?: unknown[] } | undefined;
      if (msg?.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          const b = block as { type?: string; text?: string; thinking?: string };
          const delta =
            b?.type === "text" && typeof b.text === "string"
              ? { type: "text_delta", delta: b.text }
              : b?.type === "thinking" && typeof b.thinking === "string"
                ? { type: "thinking_delta", delta: b.thinking }
                : null;
          if (delta) {
            const d = gm.observe({ type: "message_update", assistantMessageEvent: delta });
            if (d) { record(d, i); if (d.action === "kill") break; }
          }
        }
      }
      continue;
    }
    const d = gm.observe(ev);
    if (d) record(d, i);
  }
  // record(d, i): push {decision: d, lineIndex: i, runIndex: run.index}; on kill set killed=true, run.stoppedAtKill=true.
  // identical: every run's recorded[] and replayed[] agree pairwise on (action, kind, turnIndex).
  // caveats: always include the two epistemic notes (message-granular rep replay; post-decision
  // trajectories are what-if); add "v1 transcript: run boundaries inferred from agent_end" when version === 1.
  return { version, runs, invalidLines, caveats, identical };
}
```

Resolve the sketch's rough edges cleanly (implicit-run opening for v1, the `record` closure over `run`); the tests define the contract. Type SDK events defensively as `Record<string, unknown>` with local casts, matching `guardManager.ts`'s own style.

- [ ] **Step 3: Tests pass, full suite green.** ARCHITECTURE.md row for `replay.ts`. Prettier, commit: `feat(agent): transcript replay engine`

---

### Task 9: Live/replay parity test

**Files:**
- Test: `tests/replayParity.test.ts` (new; no src changes expected — this task exists to *prove* fidelity, and any divergence it finds is a bug to fix in `replay.ts`)

**Interfaces:**
- Consumes: `runEnveloped` (Task 4), `replayTranscript` (Task 8), `makeSession`-style fakes from `tests/helpers/fakeSession.ts` (extend the helper only if its exported builders can't emit `message_end` — prefer a test-local builder modeled on `makeSession`, which is not exported; check first).

- [ ] **Step 1: Write the test.** Drive one scripted stream through the REAL live path, capture the transcript in memory, replay it, and assert decision parity:

```ts
it("replay reproduces the live path's decisions from its own transcript", async () => {
  // Stream: realistic assistant turns + a tool-call loop that trips the guard.
  // Build with a session that emits: message_start, message_update deltas,
  // message_end (full text), N× tool_execution_start/end ("bash", same args),
  // turn_end — enough to trip ToolCallLoopGuard (threshold from guards.ts).
  const lines: string[] = [];
  const liveDecisions: Array<{ action: string; kind: string; turnIndex: number }> = [];
  await runEnveloped(
    { ...makeConfig(), transcriptsEnabled: true, supervisorEnabled: true },
    { ticketId: "parity-1", flow: "qa", body: "go", cwd: "/w", timeoutMs: 5000 },
    {
      createSession: loopingFakeSession(), // test-local builder
      onGuardDecision: (d) => liveDecisions.push({ action: d.action, kind: d.kind, turnIndex: d.turnIndex }),
      transcriptSink: () => ({ write: (l) => lines.push(l.trimEnd()), end: () => {} }),
      fileExists: () => false,
    },
  );
  const report = replayTranscript(lines, {
    guard: guardOptionsFromConfig({ ...makeConfig(), supervisorEnabled: true }),
  });
  expect(report.version).toBe(2);
  expect(report.identical).toBe(true);
  expect(report.runs[0].replayed.map((r) => ({
    action: r.decision.action, kind: r.decision.kind, turnIndex: r.decision.turnIndex,
  }))).toEqual(liveDecisions);
});

it("parity holds for a no-decision run", async () => { /* same shape, clean stream, expect zero decisions both sides */ });
```

The fake must emit both `message_update` deltas AND a matching `message_end` (live GuardManager consumes the deltas; replay consumes the `message_end`) — this cross-representation agreement is exactly what the test certifies.

- [ ] **Step 2: Run; fix any divergence in `replay.ts`** (not in the live path — live is the reference). Full suite, prettier, commit: `test(agent): live/replay decision parity`

---

### Task 10: `junco replay` CLI + docs

**Files:**
- Create: `src/replayCmd.ts`
- Modify: `src/cli.ts` (dispatch + help text)
- Test: `tests/replayCmd.test.ts`
- Docs: ARCHITECTURE.md row; `CHANGELOG.md` (Unreleased); `CLAUDE.md` debugging line gains `junco replay <id>`

**Interfaces:**
- Consumes: `replayTranscript` + `ReplayReport` (Task 8), `guardOptionsFromConfig` (Task 1), `transcriptPathFor`/`dataTreePaths`, `loadConfig`.
- Produces: `runReplayCmd(argv: string[], deps: ReplayCmdDeps): Promise<number>` where

```ts
export interface ReplayCmdDeps {
  loadCfg: () => Config;                       // may throw (no config) — see fallback
  readFile: (path: string) => string;          // throws ENOENT
  stdout: (line: string) => void;
}
```

- [ ] **Step 1: Read `src/statusCmd.ts` and the `retry` dispatch in `src/cli.ts:627`** to copy the house pattern for a subcommand with a positional arg + flags.

- [ ] **Step 2: Write the failing tests**

```ts
describe("runReplayCmd", () => {
  const deps = (files: Record<string, string>, cfg = makeConfig()) => {
    const out: string[] = [];
    return {
      out,
      d: {
        loadCfg: () => cfg,
        readFile: (p: string) => { if (files[p] === undefined) throw new Error("ENOENT"); return files[p]; },
        stdout: (l: string) => out.push(l),
      },
    };
  };

  it("resolves a bare ticket id through the data tree", async () => {
    const cfg = makeConfig();
    const path = transcriptPathFor(dataTreePaths(cfg).transcripts, "t-1");
    const fixture = [runStart("qa"), toolStart("bash", { command: "ls" }), turnEnd(), agentEnd()].join("\n");
    const { out, d } = deps({ [path]: fixture }, cfg);
    const code = await runReplayCmd(["t-1"], d);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("run 1");
  });
  it("accepts a direct .jsonl path", async () => { /* argv: ["/x/y.jsonl"]; loadCfg may throw → still works with defaults */ });
  it("applies policy flags over config", async () => { /* --budget-per-kind=0 flips the fixture's nudge to kill; output says so */ });
  it("emits machine-readable JSON with --json", async () => { /* JSON.parse(out.join("")) has runs/identical/caveats */ });
  it("exits 1 with a hint when the transcript is missing", async () => { /* unknown id → exit 1, message mentions transcripts dir */ });
});
```

Fixture lines: reuse the Task 8 builders (extract them into `tests/helpers/transcriptFixtures.ts` if both suites want them — do extract; two copies of event builders is the exact disease this plan treats).

- [ ] **Step 3: Implement.** Behavior spec:
  - `junco replay <ticket-id | path.jsonl> [--budget-per-kind N] [--escalation-window N] [--output-budget-per-turn N] [--output-budget-post-commit N] [--json]`
  - Target resolution: argument ending in `.jsonl` or containing `/` → literal path; else ticket id → `transcriptPathFor(dataTreePaths(cfg).transcripts, id)` (requires config; a config-load failure with a bare id is exit 1 with a clear message).
  - Policy precedence per knob: explicit flag > first `junco_run_start.guard` in the file (v2) > loaded config via `guardOptionsFromConfig` > GuardManager defaults. Report the source line: `policy: budgetPerKind=1 escalationWindow=3 (source: recorded run_start)`.
  - Text report: one line per run — `run 2 (pr_corrective): recorded kill(output_budget@t2) → replayed kill(output_budget@t2) ✓`, then `verdict: decisions identical under this policy` or a divergence list, then `caveats:` lines from the report.
  - `--json`: `JSON.stringify(report, null, 2)` to stdout, nothing else.
  - Wire into `cli.ts` dispatch (`if (subcommand === "replay") ...`) with real fs/config deps, and add the one-line usage entry to the CLI help block.

- [ ] **Step 4: Tests pass, full suite green.**

- [ ] **Step 5: Docs.** ARCHITECTURE.md row for `replayCmd.ts`; CHANGELOG.md Unreleased entry (`### Added` — replay CLI + v2 transcript frame records; `### Changed` — agent runs unified through runEnveloped); CLAUDE.md "Debugging & visibility" transcript bullet gains: `junco replay <id>` re-runs a transcript through the guards under any policy.

- [ ] **Step 6: Prettier, full gate, commit:** `feat(cli): junco replay — guard-policy what-if over recorded transcripts`

---

### Task 11 (optional — drop if review flags scope): shared `isRoutableFailure` predicate

**Files:**
- Modify: `src/providerFailure.ts`, `src/runOnce.ts:445,461,477`, `src/prFlow.ts` (its `hardError` site — locate with `grep -n "abortedByGuard" src/prFlow.ts`)
- Test: `tests/providerFailure.test.ts`

The `#180.3` parity rule — a result is routable to the provider gate only when `!timedOut && !abortedByGuard` (a timed-out run carries a STALE first-attempt errorMessage) — lives as three inline copies in runOnce plus prFlow's `hardError` guard, kept in sync by comments.

- [ ] **Step 1: Test** `isRoutableFailure(result)` truth table (4 combinations).
- [ ] **Step 2: Implement** in `providerFailure.ts`: `export const isRoutableFailure = (r: Pick<RunResult, "timedOut" | "abortedByGuard">): boolean => !r.timedOut && !r.abortedByGuard;`
- [ ] **Step 3: Adopt at the runOnce sites** (`deps.gate && isRoutableFailure(result) && GATE_CLASSES.has(cls)` etc.) and prFlow's hardError site **only if** its predicate is exactly this expression — if it differs, leave it and say why in the commit message. Keep the #180.3 comments; point them at the predicate.
- [ ] **Step 4: Full gate, commit:** `refactor: shared isRoutableFailure predicate (#180.3 parity in one place)`

---

## Acceptance (manual, maintainer)

After merge: `junco replay <id-of-a-real-failed-ticket>` against the live archive in `~/.junco/data/transcripts/` — pre-change (v1) files must produce a report with the v1 caveat; a post-change failed ticket must show `identical: true` under the recorded policy. This is the tool's reason to exist; eyeball it once on real data.

## Explicitly out of scope

Resume/fork (1c — future spec; this plan records its substrate), delta/chunk transcript records (unnecessary — `message_end` carries full messages), TUI replay view, full outcome-router extraction beyond Task 11's predicate.
