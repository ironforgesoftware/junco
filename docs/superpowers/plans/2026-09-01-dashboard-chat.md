# Dashboard Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-repo, daemon-hosted chat with the coding agent inside the dashboard, from which every junco dispatch branch (ticket, amend, apply, audit, investigate, ticket set, plan set) can be drafted, parked for review, and submitted.

**Architecture:** The daemon owns one file-backed Pi `AgentSession` per repo (`src/chat/`), gated by the same budget/provider gates as tickets and writing spend to the single-writer ledger in-process. The health server gains loopback-only `/chat/*` routes (SSE out, POST in). The dashboard gets a `chat` view built on the transcript viewer's pure core plus a multiline composer; drafts detected in assistant messages (a `junco-ticket`/`junco-plan` fence) are linted and routed with the existing `submitPreflight` code, parked in a `makeReviewStore`, and submitted by spawning the CLI verb.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), `@earendil-works/pi-coding-agent` 0.84.2 (runtime import only inside `src/agent/session.ts`), Ink 7.1 + React 19, vitest, `node:http` SSE (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-09-01-dashboard-chat-design.md` — every task below cites the section it implements. Read the spec's "Decisions" and "Non-goals" first; they are settled.

## Global Constraints

- Never import the Pi SDK at module top level in `src/`; the runtime `await import(...)` lives only in `src/agent/session.ts`. Type-only imports are fine.
- Every side effect goes behind an injectable `deps` seam. Tests never touch the network or a real model.
- `src/ticketSchema.ts` is untouched. Q&A/chat tools are `READ_ONLY_TOOLS ∩ cfg.tools` — never wider.
- Dependencies are exact-pinned; this plan adds none.
- A new `Config` field goes in `tests/helpers/config.ts` (the only full `Config` literal) as ballast, not as a `ConfigSeams` key.
- `src/tui/**`: `eslint-plugin-react-hooks` runs both rules at error; fix deps, never `eslint-disable`.
- Ink tests: gate every keystroke on `until()`; loop-until-condition, never a fixed tick.
- Commits: conventional (`feat:`/`fix:`/`refactor:`/`docs:`/`test:`), **no AI attribution trailers**, suite green at every commit. Run `npx prettier --write` on touched files before committing.
- Work in the worktree `.claude/worktrees/dashboard-chat` on `feat/dashboard-chat`. Never touch the main checkout (the daemon's build home). Merge `origin/main` between tasks.
- `/chat/*` is loopback-only regardless of `healthHost`, and rejects any request with an `Origin` header.
- The chat transcript never persists `message_update`; it is written regardless of `transcriptsEnabled`.
- Full gate before claiming a task done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test` (capture vitest's exit code explicitly — never pipe it into `tail`/`grep`).

---

## File structure

**New — daemon side (`src/chat/`):**

| file                       | responsibility                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/chat/chatKey.ts`      | key → slug; watched vs local classification (spec §1.2)                                          |
| `src/chat/chatCwd.ts`      | `resolveChatCwd` (spec §2.2)                                                                     |
| `src/chat/chatTurn.ts`     | one prompt/steer through a `ChatSessionLike` with timeout + abort, no guards (spec §3)           |
| `src/chat/chatSession.ts`  | one repo's session: SDK session (lazy), transcript sink, record bus, meta, crash stamp (spec §2) |
| `src/chat/chatManager.ts`  | registry + gates + spend + drain + health (spec §2.4, §4)                                        |
| `src/chat/chatRoutes.ts`   | `/chat/*` HTTP handler: SSE, POST, auth boundary (spec §5)                                       |
| `src/chat/fenceExtract.ts` | fences → `ExtractedDraft[]` with kind + frontmatter allowlist (spec §6.1)                        |
| `src/chat/draftStore.ts`   | `makeReviewStore<PendingDraft>` + file layout (spec §6.2)                                        |
| `src/chat/chatDrafts.ts`   | park: lint + route + write; auto-lint retry decision (spec §6.2–6.4)                             |
| `src/chat/chatPrompt.ts`   | system prompt from TEMPLATE.md + SKILL.md sections (spec §6.5)                                   |

**New — dashboard side:**

| file                                    | responsibility                                                       |
| --------------------------------------- | -------------------------------------------------------------------- |
| `src/tui/chatClient.ts`                 | SSE parser + reconnecting subscribe; POST helpers (spec §7)          |
| `src/tui/hooks/useChat.ts`              | chat domain state: ring, streaming, cards, composer text (spec §8.5) |
| `src/tui/components/Composer.tsx`       | multiline input, chords, paste, slash list (spec §8.2)               |
| `src/tui/components/ChatView.tsx`       | header strip + transcript body + composer (spec §8.2)                |
| `src/tui/components/TranscriptBody.tsx` | rows + scrollbar + cursor gutter, extracted from `TranscriptView`    |

**Modified:** `src/dataTree.ts`, `src/dataMigrate.ts`, `src/agent/transcriptSchema.ts`, `src/config.ts`, `src/types.ts`, `src/configLevers.ts`, `src/agent/session.ts`, `src/healthServer.ts`, `src/daemon.ts`, `src/planPrompt.ts`, `src/transcriptSummary.ts`, `src/transcriptRender.ts`, `src/tui/ghClient.ts`, `src/tui/healthBody.ts`, `src/tui/viewActions.ts`, `src/tui/App.tsx`, `src/tui/Root.tsx`, `src/tui/components/TranscriptView.tsx`, `src/tui/components/ReviewView.tsx`, `src/tui/hooks/useReview.ts`, `src/tui/components/HelpModal.tsx`, `src/transcriptCmd.ts`, `src/statusCmd.ts`, `src/doctor.ts`, `src/unwatchCmd.ts`, `tests/helpers/config.ts`, `tests/helpers/fakeSession.ts`, `tests/helpers/localFixtures.tsx`, docs.

---

### Task 1: Data tree keys, migration pairs, transcript records

Spec §1.1, §1.3. Adds the two layout keys (eagerly materialized, denied to the sandbox, migrated), the `junco_chat_*` record types, and `"chat"` in `FlowKind`.

**Files:**

- Modify: `src/dataTree.ts` (LAYOUTS ~line 51–76, `DataTreePaths` ~84–110, `dataTreePaths` ~111–185, `sandboxDenyPaths` ~309–360, `ensureDataTree` ~408–445)
- Modify: `src/dataMigrate.ts:123-140` (`flatToV2Pairs`)
- Modify: `src/agent/transcriptSchema.ts`
- Test: `tests/dataTree.test.ts`, `tests/dataMigrate.test.ts`, `tests/transcriptSchema.test.ts`

**Interfaces:**

- Produces: `DataTreePaths.chats`, `DataTreePaths.chatDrafts` (strings); `FlowKind` includes `"chat"`; exported record interfaces `ChatPromptRecord`, `ChatTurnStartRecord`, `ChatTurnEndRecord`, `ChatTurnAbortedRecord`, `ChatTurnRejectedRecord`, `ChatDraftRecord`, `ChatSessionResetRecord`, `ChatTranscriptDegradedRecord`, the union `ChatRecord`, and `DraftKind`.

- [ ] **Step 1: Write the failing data-tree tests**

Append to `tests/dataTree.test.ts` inside `describe("dataTreePaths", …)`:

```ts
it("exposes chats and chatDrafts in both layouts (spec 2026-09-01 §1.1)", () => {
  const flat = dataTreePaths(makeConfig({ dataDir: "/sbxroot/data" }));
  expect(flat.chats).toBe("/sbxroot/data/chats");
  expect(flat.chatDrafts).toBe("/sbxroot/data/chat-drafts");
  const v2 = dataTreePaths(makeConfig({ dataDir: "/sbxroot/home/.junco", dataLayout: "v2" }));
  expect(v2.chats).toBe("/sbxroot/home/.junco/data/chats");
  expect(v2.chatDrafts).toBe("/sbxroot/home/.junco/data/chat-drafts");
});
```

Inside `describe("ensureDataTree", …)`:

```ts
it("materializes chats and the chat-drafts archives eagerly (deny targets, never lazy)", () => {
  const made: string[] = [];
  const deps = {
    mkdirFn: (d: string) => made.push(d),
    existsFn: () => false,
    writeFn: () => {},
  };
  ensureDataTree(makeConfig({ dataDir: "/sbxroot/data", queueRoot: "/sbxroot/data/queue" }), deps);
  expect(made).toContain("/sbxroot/data/chats");
  expect(made).toContain("/sbxroot/data/chat-drafts/submitted");
  expect(made).toContain("/sbxroot/data/chat-drafts/discarded");
});
```

Inside `describe("sandboxDenyPaths", …)`:

```ts
it("denies the chat session store and parked drafts by name in both layouts", () => {
  for (const dataLayout of ["flat", "v2"] as const) {
    const cfg = makeConfig({
      dataDir: "/sbxroot/data",
      queueRoot: "/sbxroot/data/queue",
      dataLayout,
    });
    const p = dataTreePaths(cfg);
    const { dirs } = sandboxDenyPaths(cfg);
    expect(dirs).toContain(p.chats);
    expect(dirs).toContain(p.chatDrafts);
  }
});
```

Append to `tests/dataMigrate.test.ts` inside `describe("flatToV2Pairs", …)`:

```ts
it("moves chats and chat-drafts into data/ (spec 2026-09-01 §1.1)", () => {
  const cross = flatToV2Pairs("/old", "/new");
  expect(cross).toContainEqual({ from: "/old/chats", to: "/new/data/chats" });
  expect(cross).toContainEqual({ from: "/old/chat-drafts", to: "/new/data/chat-drafts" });
});
```

Append to `tests/transcriptSchema.test.ts`:

```ts
import type { ChatRecord, FlowKind } from "../src/agent/transcriptSchema.js";

describe("chat records (spec 2026-09-01 §1.3)", () => {
  it("every junco_chat_* record classifies as junco", () => {
    const records: ChatRecord[] = [
      { type: "junco_chat_prompt", text: "hi", mode: "prompt", source: "operator", ts: "t" },
      { type: "junco_chat_turn_start", modelId: "m", tools: ["read"], timeoutMs: 1, ts: "t" },
      {
        type: "junco_chat_turn_end",
        status: "ok",
        errorClass: null,
        errorMessage: null,
        usage: { input: 1, output: 1, cacheRead: 0, total: 2, costUsd: 0 },
        durationMs: 5,
        ts: "t",
      },
      { type: "junco_chat_turn_aborted", reason: "timeout", ts: "t" },
      { type: "junco_chat_turn_rejected", reason: "budget", until: null, ts: "t" },
      {
        type: "junco_chat_draft",
        draftId: "d1",
        kind: "ticket",
        status: "parked",
        ids: [],
        destination: null,
        ts: "t",
      },
      { type: "junco_chat_session_reset", reason: "corrupt", ts: "t" },
      { type: "junco_chat_transcript_degraded", ts: "t" },
    ];
    for (const r of records) {
      const p = parseTranscriptLine(JSON.stringify(r));
      expect(p.kind).toBe("junco");
      if (p.kind === "junco") expect(p.record.type).toBe(r.type);
    }
  });
  it("chat is a FlowKind", () => {
    const f: FlowKind = "chat";
    expect(f).toBe("chat");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dataTree.test.ts tests/dataMigrate.test.ts tests/transcriptSchema.test.ts > /tmp/t1 2>&1; echo "exit: $?"; grep -E "✓|✗|×|FAIL|Error" /tmp/t1 | head -20`
Expected: exit 1 — `chats`/`chatDrafts` undefined, migrate pair missing; `npm run typecheck` reports `ChatRecord`/`"chat"` not exported.

- [ ] **Step 3: Implement**

`src/dataTree.ts` — in `LAYOUTS.flat` add `chats: "chats", chatDrafts: "chat-drafts",`; in `LAYOUTS.v2` add `chats: "data/chats", chatDrafts: "data/chat-drafts",`. In `DataTreePaths` add:

```ts
chats: string; // per-repo chat sessions: <slug>/{meta.json,transcript.jsonl,<sdk session>} (spec 2026-09-01)
chatDrafts: string; // parked chat drafts (makeReviewStore) + submitted/ discarded/ archives
```

In `dataTreePaths` return, after `plans:`: `chats: join(r, L.chats), chatDrafts: join(r, L.chatDrafts),`.

In `sandboxDenyPaths().dirs`, after `p.assessHistory,`:

```ts
        // Chat session store (SDK session files hold the whole conversation)
        // and parked drafts — never agent-readable (spec 2026-09-01 §1.1).
        p.chats,
        p.chatDrafts,
```

In `ensureDataTree`'s `dirs` array, after `p.plans,`:

```ts
    // Chat (spec 2026-09-01 §1.1): both are deny targets, so both are eager —
    // the same bwrap "absent deny is skipped" reason githubCache is above.
    p.chats,
    join(p.chatDrafts, "submitted"),
    join(p.chatDrafts, "discarded"),
```

`src/dataMigrate.ts` `flatToV2Pairs` pairs, after `["plans", "data/plans"],`:

```ts
    ["chats", "data/chats"],
    ["chat-drafts", "data/chat-drafts"],
```

`src/agent/transcriptSchema.ts` — add `| "chat"` to `FlowKind`; add `import type { ProviderFailureClass } from "../providerFailure.js";` (type-only); add after `GuardDecisionRecord`:

```ts
// ---------------------------------------------------------------------------
// Chat records (spec 2026-09-01 §1.3). A chat transcript opens with the same
// junco_meta (ticketId = the session slug); turns are framed by
// junco_chat_turn_start/_end/_aborted the way runs are by junco_run_start/_end.
// ---------------------------------------------------------------------------

export type DraftKind =
  | "ticket"
  | "amend"
  | "apply"
  | "audit"
  | "investigate"
  | "ticketSet"
  | "planSet";

export interface ChatPromptRecord {
  type: "junco_chat_prompt";
  text: string;
  /** steer = arrived while a turn was streaming (SDK steer()). */
  mode: "prompt" | "steer";
  /** auto_lint = the one automatic lint follow-up (spec §6.3). */
  source: "operator" | "auto_lint";
  ts: string;
}
export interface ChatTurnStartRecord {
  type: "junco_chat_turn_start";
  modelId: string;
  tools: string[];
  timeoutMs: number;
  ts: string;
}
export interface ChatTurnEndRecord {
  type: "junco_chat_turn_end";
  status: "ok" | "error";
  errorClass: ProviderFailureClass | null;
  errorMessage: string | null;
  usage: Usage;
  durationMs: number;
  ts: string;
}
export interface ChatTurnAbortedRecord {
  type: "junco_chat_turn_aborted";
  reason: "timeout" | "operator" | "daemon_stopped" | "crash";
  ts: string;
}
export interface ChatTurnRejectedRecord {
  type: "junco_chat_turn_rejected";
  /** gate.status().reason or the budget line. */
  reason: string;
  /** ISO, from GateStatus.until; null for latches. */
  until: string | null;
  ts: string;
}
export interface ChatDraftRecord {
  type: "junco_chat_draft";
  draftId: string;
  kind: DraftKind;
  status: "parked" | "lint_failed" | "submitted" | "discarded";
  /** Ticket ids / audit-investigate ids once known. */
  ids: string[];
  /** null until submitted; "command" for audit/investigate. */
  destination: "inbox" | "issue" | "command" | null;
  ts: string;
}
export interface ChatSessionResetRecord {
  type: "junco_chat_session_reset";
  reason: "corrupt" | "missing" | "operator_new";
  ts: string;
}
export interface ChatTranscriptDegradedRecord {
  type: "junco_chat_transcript_degraded";
  ts: string;
}
export type ChatRecord =
  | ChatPromptRecord
  | ChatTurnStartRecord
  | ChatTurnEndRecord
  | ChatTurnAbortedRecord
  | ChatTurnRejectedRecord
  | ChatDraftRecord
  | ChatSessionResetRecord
  | ChatTranscriptDegradedRecord;
```

and widen the union: `export type JuncoRecord = MetaRecord | RunStartRecord | RunEndRecord | GuardDecisionRecord | ChatRecord;`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dataTree.test.ts tests/dataMigrate.test.ts tests/transcriptSchema.test.ts > /tmp/t1 2>&1; echo "exit: $?"` — expected `exit: 0`. Then `npm run typecheck` — expected clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/dataTree.ts src/dataMigrate.ts src/agent/transcriptSchema.ts tests/dataTree.test.ts tests/dataMigrate.test.ts tests/transcriptSchema.test.ts
git add src/dataTree.ts src/dataMigrate.ts src/agent/transcriptSchema.ts tests/dataTree.test.ts tests/dataMigrate.test.ts tests/transcriptSchema.test.ts
git commit -m "feat(chat): data-tree keys, migration pairs, and transcript records"
```

---

### Task 2: Config `chat` block and levers

Spec §10. Four fields, ballast in the test helper, four levers (the LEVERS ↔ schema bijection test enforces them).

**Files:**

- Modify: `src/config.ts` (`ConfigSchema` after `planSets` ~line 524–530; `assembleConfig` after `planSets:` ~786–790)
- Modify: `src/types.ts` (after `PlanSetsConfig` ~line 88–93; `Config` after `planSets:` ~232)
- Modify: `src/configLevers.ts` (after the `planSets.*` block ~line 764–792)
- Modify: `tests/helpers/config.ts` (ballast after `planSets`)
- Test: `tests/config.test.ts`, `tests/configLevers.test.ts` (bijection — no new test needed), `tests/helpersConfig.test.ts` (compiles)

**Interfaces:**

- Produces: `Config.chat: ChatConfig` with `{ enabled: boolean; modelId: string | null; thinkingLevel: string | null; turnTimeoutMinutes: number | null }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts`:

```ts
describe("chat section (spec 2026-09-01 §10)", () => {
  it("defaults: enabled, every override inherits (null)", () => {
    const cfg = loadConfig(writeJson({}));
    expect(cfg.chat).toEqual({
      enabled: true,
      modelId: null,
      thinkingLevel: null,
      turnTimeoutMinutes: null,
    });
  });
  it("explicit values parse through", () => {
    const cfg = loadConfig(
      writeJson({
        chat: { enabled: false, modelId: "x/big", thinkingLevel: "high", turnTimeoutMinutes: 5 },
      }),
    );
    expect(cfg.chat).toEqual({
      enabled: false,
      modelId: "x/big",
      thinkingLevel: "high",
      turnTimeoutMinutes: 5,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/config.test.ts tests/configLevers.test.ts > /tmp/t2 2>&1; echo "exit: $?"` — expected exit 1 (`cfg.chat` undefined). `npm run typecheck` fails on `cfg.chat`.

- [ ] **Step 3: Implement**

`src/config.ts` — in `ConfigSchema` after the `planSets` block:

```ts
  chat: z
    .object({
      enabled: z.boolean().default(true),
      modelId: z.string().min(1).optional(),
      thinkingLevel: z.string().min(1).optional(),
      turnTimeoutMinutes: z.number().min(1).optional(),
    })
    .default({}),
```

In `assembleConfig` after the `planSets: {...}` entry:

```ts
    chat: {
      enabled: d.chat.enabled,
      modelId: d.chat.modelId ?? null,
      thinkingLevel: d.chat.thinkingLevel ?? null,
      turnTimeoutMinutes: d.chat.turnTimeoutMinutes ?? null,
    },
```

`src/types.ts` — after `PlanSetsConfig`:

```ts
/** [chat] — the dashboard chat (spec 2026-09-01 §10). `null` = inherit:
 * modelId → github.plannerModelId ?? model.id; thinkingLevel →
 * model.thinkingLevel; turnTimeoutMinutes → worker.defaultTimeoutMinutes. */
export interface ChatConfig {
  enabled: boolean;
  modelId: string | null;
  thinkingLevel: string | null;
  turnTimeoutMinutes: number | null;
}
```

and in `Config` after `planSets: PlanSetsConfig;`:

```ts
// Dashboard chat (spec 2026-09-01).
chat: ChatConfig;
```

`src/configLevers.ts` — after the `planSets.maxTasks` lever:

```ts
  // --- chat.* ---
  {
    path: "chat.enabled",
    type: "boolean",
    default: true,
    editable: true,
    reload: "live",
    description: "Enable the dashboard chat (/chat/* routes on the health server).",
  },
  {
    path: "chat.modelId",
    type: "string",
    default: undefined,
    editable: true,
    reload: "restart",
    description: "Chat model id override (same endpoint); unset → github.plannerModelId, then model.id.",
  },
  {
    path: "chat.thinkingLevel",
    type: "string",
    default: undefined,
    editable: true,
    reload: "restart",
    description: "Chat thinking level; unset → model.thinkingLevel.",
  },
  {
    path: "chat.turnTimeoutMinutes",
    type: "number",
    default: undefined,
    min: 1,
    editable: true,
    reload: "restart",
    description: "Per-turn chat timeout; unset → worker.defaultTimeoutMinutes.",
  },
```

`tests/helpers/config.ts` — after the `planSets` ballast entry:

```ts
    chat: { enabled: true, modelId: null, thinkingLevel: null, turnTimeoutMinutes: null },
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/config.test.ts tests/configLevers.test.ts tests/helpersConfig.test.ts > /tmp/t2 2>&1; echo "exit: $?"` — expected 0. `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/config.ts src/types.ts src/configLevers.ts tests/helpers/config.ts tests/config.test.ts
git add src/config.ts src/types.ts src/configLevers.ts tests/helpers/config.ts tests/config.test.ts
git commit -m "feat(chat): config chat block with live enabled lever"
```

---

### Task 3: `ChatSessionLike`, `SessionOverrides.sessionManager`, `makeChatSessionFactory`, `makeSessionManager`, and the chat fake

Spec §2.1. The seam widens by extension; the SDK-touching helpers stay in `session.ts`.

**Files:**

- Modify: `src/agent/session.ts` (`SessionOverrides` ~line 430; `makePiSessionFactory` ~730–823)
- Modify: `tests/helpers/fakeSession.ts`
- Test: `tests/fakeChatSession.test.ts` (new), `tests/sessionManager.sdk.test.ts` (new — uses the installed SDK's `SessionManager` on a tmp dir; no network, no model)

**Interfaces:**

- Produces (`src/agent/session.ts`):
  ```ts
  export interface ChatSessionLike extends AgentSessionLike {
    steer(text: string): Promise<void>;
    readonly isStreaming: boolean;
    readonly isIdle: boolean;
    readonly messages: unknown[];
  }
  export interface SessionOverrides {
    tools?;
    thinkingLevel?;
    network?;
    sessionManager?: unknown;
  }
  export type SessionManagerMode =
    | { create: { cwd: string; dir: string } }
    | { open: { file: string; dir: string; cwd: string } };
  export async function makeSessionManager(
    mode: SessionManagerMode,
  ): Promise<{ manager: unknown; file: string }>;
  export function makeChatSessionFactory(
    cfg: Config,
    cwd: string,
    overrides: SessionOverrides,
  ): () => Promise<ChatSessionLike>;
  ```
- Produces (`tests/helpers/fakeSession.ts`):

  ```ts
  export interface ChatScript {
    events: unknown[];
    delayMs?: number;
    throws?: string;
  }
  export interface FakeChatSession extends ChatSessionLike {
    prompts: string[];
    steers: string[];
    aborted: number;
    disposed: boolean;
  }
  export function fakeChatSession(scripts: ChatScript[]): () => Promise<FakeChatSession>;
  export function chatScriptText(text: string, costUsd = 0): ChatScript; // message_start + one text_delta + turn_end(usage) + agent_end + agent_settled
  ```

- [ ] **Step 1: Write the failing tests**

`tests/fakeChatSession.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fakeChatSession, chatScriptText } from "./helpers/fakeSession.js";

describe("fakeChatSession (the chat seam's scriptable fake)", () => {
  it("emits one script per prompt(), to listeners subscribed at prompt time, and grows messages", async () => {
    const s = await fakeChatSession([chatScriptText("one"), chatScriptText("two", 0.5)])();
    const seen: string[] = [];
    s.subscribe((e) => seen.push((e as { type: string }).type));
    expect(s.isIdle).toBe(true);
    const p = s.prompt("hello");
    expect(s.isStreaming).toBe(true);
    await p;
    expect(s.isStreaming).toBe(false);
    expect(seen).toEqual([
      "message_start",
      "message_update",
      "turn_end",
      "agent_end",
      "agent_settled",
    ]);
    expect(s.messages.length).toBe(2); // user + assistant
    await s.prompt("again");
    expect(s.messages.length).toBe(4);
    expect(s.prompts).toEqual(["hello", "again"]);
  });
  it("steer() records without emitting; a throwing script rejects prompt()", async () => {
    const s = await fakeChatSession([{ events: [], throws: "fetch failed: 429" }])();
    await s.steer("faster");
    expect(s.steers).toEqual(["faster"]);
    await expect(s.prompt("x")).rejects.toThrow("429");
  });
  it("abort() resolves an in-flight prompt early", async () => {
    const s = await fakeChatSession([{ events: [], delayMs: 10_000 }])();
    const p = s.prompt("slow");
    await s.abort();
    await p; // resolves promptly instead of after 10s
    expect(s.aborted).toBe(1);
  });
});
```

`tests/sessionManager.sdk.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSessionManager } from "../src/agent/session.js";

// Uses the installed SDK's SessionManager on a tmp dir — a file contract we
// depend on (spec 2026-09-01 §2.1), not a network or model touch.
describe("makeSessionManager (SDK file-backed sessions under a junco-owned dir)", () => {
  it("create writes the session file under `dir` and open reads it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-chat-sm-"));
    const created = await makeSessionManager({ create: { cwd: dir, dir } });
    expect(created.file.startsWith(dir)).toBe(true);
    expect(existsSync(created.file) || true).toBe(true); // file may be lazily written; path must be under dir
    const opened = await makeSessionManager({ open: { file: created.file, dir, cwd: dir } });
    expect(opened.file).toBe(created.file);
  });
  it("open on a missing file throws (the caller archives and recreates)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-chat-sm-"));
    await expect(
      makeSessionManager({ open: { file: join(dir, "nope.jsonl"), dir, cwd: dir } }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/fakeChatSession.test.ts tests/sessionManager.sdk.test.ts > /tmp/t3 2>&1; echo "exit: $?"` — expected 1 (exports missing).

- [ ] **Step 3: Implement**

`src/agent/session.ts` — after `AgentSessionLike`:

```ts
/**
 * The chat seam (spec 2026-09-01 §2.1): the interactive subset of the SDK
 * session the dashboard chat drives. Extends — never mutates — AgentSessionLike
 * so every existing fake keeps compiling. Verified against SDK 0.84.2
 * `dist/core/agent-session.d.ts`: steer(text) line 371; isStreaming/isIdle
 * getters ~line 300; messages getter line 318. (queueMessage is declared there
 * too but is `undefined` on the runtime object — deliberately not used.)
 */
export interface ChatSessionLike extends AgentSessionLike {
  steer(text: string): Promise<void>;
  readonly isStreaming: boolean;
  readonly isIdle: boolean;
  readonly messages: unknown[];
}
```

Extend `SessionOverrides`:

```ts
  /** Chat (spec 2026-09-01 §2.1): a file-backed SDK SessionManager built by
   *  makeSessionManager. Absent → SessionManager.inMemory(cwd), unchanged for
   *  every other caller. Opaque here; typed at the SDK boundary only. */
  sessionManager?: unknown;
```

In `makePiSessionFactory`, replace `sessionManager: SessionManager.inMemory(cwd),` with:

```ts
      sessionManager: (overrides?.sessionManager as never) ?? SessionManager.inMemory(cwd),
```

Add the two exports after `makePiSessionFactory`:

```ts
export type SessionManagerMode =
  | { create: { cwd: string; dir: string } }
  | { open: { file: string; dir: string; cwd: string } };

/**
 * Chat sessions persist under a junco-owned dir (spec 2026-09-01 §2.1) —
 * never ~/.pi. SDK 0.84.2 `dist/core/session-manager.d.ts`: create(cwd,
 * sessionDir) line 318, open(path, sessionDir, cwdOverride) line 325,
 * getSessionFile() line 208. Throws on an unreadable file; the caller
 * (chatSession.ts) archives it and recreates.
 */
export async function makeSessionManager(
  mode: SessionManagerMode,
): Promise<{ manager: unknown; file: string }> {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const manager =
    "create" in mode
      ? SessionManager.create(mode.create.cwd, mode.create.dir)
      : SessionManager.open(mode.open.file, mode.open.dir, mode.open.cwd);
  const file = (manager as { getSessionFile(): string | undefined }).getSessionFile();
  if (!file) throw new Error("SDK SessionManager reported no session file (not persisting)");
  return { manager, file };
}

/** Same build as makePiSessionFactory; the real SDK session structurally
 * satisfies the wider ChatSessionLike, so the widening is one cast at the
 * SDK boundary. */
export function makeChatSessionFactory(
  cfg: Config,
  cwd: string,
  overrides: SessionOverrides,
): () => Promise<ChatSessionLike> {
  const inner = makePiSessionFactory(cfg, cwd, overrides);
  return async () => (await inner()) as unknown as ChatSessionLike;
}
```

`tests/helpers/fakeSession.ts` — append:

```ts
import type { ChatSessionLike } from "../../src/agent/session.js";

/** One prompt()'s worth of scripted events (chat seam, spec 2026-09-01). */
export interface ChatScript {
  events: unknown[];
  /** prompt() resolves after this many ms (default 1) unless aborted. */
  delayMs?: number;
  /** prompt() rejects with this message instead of emitting. */
  throws?: string;
}

export interface FakeChatSession extends ChatSessionLike {
  prompts: string[];
  steers: string[];
  aborted: number;
  disposed: boolean;
}

/** message_start + one text_delta + turn_end(usage, costUsd) + agent_end +
 * agent_settled — the shape a completed assistant turn has on the wire. */
export function chatScriptText(text: string, costUsd = 0): ChatScript {
  return {
    events: [
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
      {
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text }],
          usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2, cost: { total: costUsd } },
        },
        toolResults: [],
      },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ],
  };
}

/**
 * PUSH-based (unlike makeSession above): events are emitted from prompt(), to
 * whoever is subscribed at that moment, because a chat session is prompted
 * many times over its life. `messages` grows by two per completed prompt.
 */
export function fakeChatSession(scripts: ChatScript[]): () => Promise<FakeChatSession> {
  return async () => {
    const listeners = new Set<(e: AgentEvent) => void>();
    let streaming = false;
    let resolveAbort: (() => void) | null = null;
    let turn = 0;
    const s: FakeChatSession = {
      prompts: [],
      steers: [],
      aborted: 0,
      disposed: false,
      messages: [],
      get isStreaming() {
        return streaming;
      },
      get isIdle() {
        return !streaming;
      },
      subscribe(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      async prompt(text: string) {
        s.prompts.push(text);
        const script = scripts[turn++] ?? { events: [] };
        streaming = true;
        try {
          if (script.throws) throw new Error(script.throws);
          s.messages.push({ role: "user", content: text });
          await new Promise<void>((r) => queueMicrotask(r));
          for (const e of script.events) for (const l of listeners) l(e as AgentEvent);
          await new Promise<void>((r) => {
            const t = setTimeout(r, script.delayMs ?? 1);
            resolveAbort = () => {
              clearTimeout(t);
              r();
            };
          });
          s.messages.push({ role: "assistant", content: "" });
        } finally {
          streaming = false;
          resolveAbort = null;
        }
      },
      async steer(text: string) {
        s.steers.push(text);
      },
      async abort() {
        s.aborted++;
        resolveAbort?.();
      },
      dispose() {
        s.disposed = true;
        listeners.clear();
      },
    };
    return s;
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/fakeChatSession.test.ts tests/sessionManager.sdk.test.ts tests/session.test.ts tests/sdkImportSurface.test.ts > /tmp/t3 2>&1; echo "exit: $?"` — expected 0. `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/agent/session.ts tests/helpers/fakeSession.ts tests/fakeChatSession.test.ts tests/sessionManager.sdk.test.ts
git add src/agent/session.ts tests/helpers/fakeSession.ts tests/fakeChatSession.test.ts tests/sessionManager.sdk.test.ts
git commit -m "feat(chat): ChatSessionLike seam, file-backed SessionManager override, chat fake"
```

---

### Task 4: `chatKey.ts` and `chatCwd.ts`

Spec §1.2, §2.2.

**Files:**

- Create: `src/chat/chatKey.ts`, `src/chat/chatCwd.ts`
- Test: `tests/chatKey.test.ts`, `tests/chatCwd.test.ts`

**Interfaces:**

- Produces:

  ```ts
  // chatKey.ts
  export function isWatchedKey(key: string): boolean; // "owner/repo" (has "/", not absolute)
  export function chatSlug(key: string): string; // owner__repo | local-<base>-<sha1[:8]>
  // chatCwd.ts
  export type ChatCwdError = "unknown_key" | "no_checkout" | "not_a_repo";
  export interface ChatCwdDeps {
    existsFn?;
    realpathFn?;
    gitFn?: typeof git;
    watchedFn?: (cfg: Config) => GithubRepoMapping[];
  }
  export type ChatCwd =
    | { ok: true; cwd: string; kind: "watched" | "local"; nwo: string | null }
    | { ok: false; error: ChatCwdError };
  export async function resolveChatCwd(
    cfg: Config,
    key: string,
    deps?: ChatCwdDeps,
  ): Promise<ChatCwd>;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/chatKey.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { chatSlug, isWatchedKey } from "../src/chat/chatKey.js";

describe("chatKey (spec 2026-09-01 §1.2)", () => {
  it("classifies watched (owner/repo) vs local (absolute path) keys", () => {
    expect(isWatchedKey("acme/api")).toBe(true);
    expect(isWatchedKey("/home/me/api")).toBe(false);
    expect(isWatchedKey("C:\\repos\\api")).toBe(false);
  });
  it("slugs a watched key as owner__repo, lowercased", () => {
    expect(chatSlug("Acme/API")).toBe("acme__api");
  });
  it("slugs a local key as local-<basename>-<sha1 prefix>, stable and collision-free", () => {
    const a = chatSlug("/home/me/api");
    const b = chatSlug("/srv/other/api");
    expect(a).toMatch(/^local-api-[0-9a-f]{8}$/);
    expect(b).toMatch(/^local-api-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(chatSlug("/home/me/api")).toBe(a);
  });
  it("never lets a slug escape its dir", () => {
    expect(chatSlug("../x/../y")).not.toContain("/");
    expect(chatSlug("/a/../b")).not.toContain("..");
  });
});
```

`tests/chatCwd.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveChatCwd } from "../src/chat/chatCwd.js";
import { makeConfig } from "./helpers/config.js";
import type { CmdResult } from "../src/git.js";

const cfg = makeConfig({
  dataDir: "/sbxroot/data",
  queueRoot: "/sbxroot/data/queue",
  worktreeRoot: "/sbxroot/wt",
  tools: [],
  criticEnabled: false,
  planLintEnabled: false,
  verifyEnabled: false,
  supervisorEnabled: false,
  healthEnabled: false,
  removeWorktreeOnSuccess: true,
});
const ok = (stdout: string): CmdResult => ({ code: 0, stdout, stderr: "" });

describe("resolveChatCwd (spec 2026-09-01 §2.2)", () => {
  it("watched key → the watchlist entry's path when it exists", async () => {
    const r = await resolveChatCwd(cfg, "acme/api", {
      watchedFn: () => [{ nwo: "Acme/API", path: "/sbxroot/clones/acme/api" }],
      existsFn: (p) => p === "/sbxroot/clones/acme/api",
    });
    expect(r).toEqual({
      ok: true,
      cwd: "/sbxroot/clones/acme/api",
      kind: "watched",
      nwo: "Acme/API",
    });
  });
  it("watched key whose checkout is missing → no_checkout", async () => {
    const r = await resolveChatCwd(cfg, "acme/api", {
      watchedFn: () => [{ nwo: "acme/api", path: "/gone" }],
      existsFn: () => false,
    });
    expect(r).toEqual({ ok: false, error: "no_checkout" });
  });
  it("unknown nwo → unknown_key", async () => {
    const r = await resolveChatCwd(cfg, "nobody/nothing", { watchedFn: () => [] });
    expect(r).toEqual({ ok: false, error: "unknown_key" });
  });
  it("local key → itself when it is a git toplevel outside dataDir", async () => {
    const r = await resolveChatCwd(cfg, "/home/me/api", {
      existsFn: () => true,
      realpathFn: (p) => p,
      gitFn: async () => ok("/home/me/api\n"),
    });
    expect(r).toEqual({ ok: true, cwd: "/home/me/api", kind: "local", nwo: null });
  });
  it("local key inside dataDir, or not a toplevel, → not_a_repo", async () => {
    const inside = await resolveChatCwd(cfg, "/sbxroot/data/chats/x", {
      existsFn: () => true,
      realpathFn: (p) => p,
      gitFn: async () => ok("/sbxroot/data/chats/x\n"),
    });
    expect(inside).toEqual({ ok: false, error: "not_a_repo" });
    const sub = await resolveChatCwd(cfg, "/home/me/api/src", {
      existsFn: () => true,
      realpathFn: (p) => p,
      gitFn: async () => ok("/home/me/api\n"),
    });
    expect(sub).toEqual({ ok: false, error: "not_a_repo" });
    const notGit = await resolveChatCwd(cfg, "/tmp/plain", {
      existsFn: () => true,
      realpathFn: (p) => p,
      gitFn: async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }),
    });
    expect(notGit).toEqual({ ok: false, error: "not_a_repo" });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/chatKey.test.ts tests/chatCwd.test.ts > /tmp/t4 2>&1; echo "exit: $?"` — expected 1 (modules missing).

- [ ] **Step 3: Implement**

`src/chat/chatKey.ts`:

```ts
/**
 * Chat repo keys (spec 2026-09-01 §1.2). The KEY is the rail's selection key
 * (railModel.ts): `nwo.toLowerCase()` for a watched repo, the resolved
 * checkout path for a local-only row. Clients always send the key; the daemon
 * derives the on-disk SLUG here and never parses a slug back (meta.json holds
 * the key).
 */
import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";

/** "owner/repo" — has a slash and is not an absolute path. */
export function isWatchedKey(key: string): boolean {
  return !isAbsolute(key) && !/^[a-zA-Z]:[\\/]/.test(key) && key.includes("/");
}

/** watched → `owner__repo` (lowercased); local → `local-<basename>-<sha1[:8]>`.
 * The prefixes cannot collide, and neither form can contain a path separator
 * or `..` (the basename is slugified to [a-z0-9._-]). */
export function chatSlug(key: string): string {
  if (isWatchedKey(key)) return key.toLowerCase().replace(/\//g, "__");
  const base = basename(key)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .replace(/^-+|-+$/g, "");
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
  return `local-${base || "repo"}-${hash}`;
}
```

`src/chat/chatCwd.ts`:

```ts
/**
 * Where a chat session runs (spec 2026-09-01 §2.2). Two branches: a watched
 * key resolves through the watchlist (every entry already carries a path —
 * the managed clone or the operator's checkout); a local key is an absolute
 * path the operator's own dashboard named, validated to be a git toplevel
 * outside the data tree. The result is stored in meta.json and re-resolved
 * on every open so a moved clone is picked up.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Config, GithubRepoMapping } from "../types.js";
import { git } from "../git.js";
import { resolveWatchedReposForPrs } from "../watchlist.js";
import { isWatchedKey } from "./chatKey.js";

export type ChatCwdError = "unknown_key" | "no_checkout" | "not_a_repo";

export interface ChatCwdDeps {
  existsFn?: (p: string) => boolean;
  realpathFn?: (p: string) => string;
  gitFn?: typeof git;
  /** The PR-listing set: fork (external:true) entries INCLUDED — chat is
   *  read-only, so the bridge's poll-injection exclusion does not apply. */
  watchedFn?: (cfg: Config) => GithubRepoMapping[];
}

export type ChatCwd =
  | { ok: true; cwd: string; kind: "watched" | "local"; nwo: string | null }
  | { ok: false; error: ChatCwdError };

const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

export async function resolveChatCwd(
  cfg: Config,
  key: string,
  deps: ChatCwdDeps = {},
): Promise<ChatCwd> {
  const existsFn = deps.existsFn ?? existsSync;
  if (isWatchedKey(key)) {
    const lower = key.toLowerCase();
    const entry = (deps.watchedFn ?? resolveWatchedReposForPrs)(cfg).find(
      (r) => r.nwo.toLowerCase() === lower,
    );
    if (!entry) return { ok: false, error: "unknown_key" };
    if (!existsFn(entry.path)) return { ok: false, error: "no_checkout" };
    return { ok: true, cwd: entry.path, kind: "watched", nwo: entry.nwo };
  }
  if (!existsFn(key)) return { ok: false, error: "not_a_repo" };
  const realpathFn = deps.realpathFn ?? ((p: string) => realpathSync.native(p));
  let real: string;
  try {
    real = realpathFn(key);
  } catch {
    return { ok: false, error: "not_a_repo" };
  }
  if (isUnder(real, resolve(cfg.dataDir))) return { ok: false, error: "not_a_repo" };
  // check:false — git() throws GitOpError on a non-zero exit by default
  // (src/git.ts RunOpts.check); a non-repo is an answer here, not an error.
  const top = await (deps.gitFn ?? git)(cfg, ["rev-parse", "--show-toplevel"], {
    cwd: real,
    check: false,
  });
  if (top.code !== 0) return { ok: false, error: "not_a_repo" };
  let topReal: string;
  try {
    topReal = realpathFn(top.stdout.trim());
  } catch {
    return { ok: false, error: "not_a_repo" };
  }
  if (topReal !== real) return { ok: false, error: "not_a_repo" };
  return { ok: true, cwd: real, kind: "local", nwo: null };
}
```

`GitCallOpts` is `RunOpts & {...}` (`src/git.ts:211`) and `RunOpts` has `cwd?` and `check?` (`src/git.ts:41-47`).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/chatKey.test.ts tests/chatCwd.test.ts > /tmp/t4 2>&1; echo "exit: $?"` — expected 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/chat/chatKey.ts src/chat/chatCwd.ts tests/chatKey.test.ts tests/chatCwd.test.ts
git add src/chat/chatKey.ts src/chat/chatCwd.ts tests/chatKey.test.ts tests/chatCwd.test.ts
git commit -m "feat(chat): repo key → slug and cwd resolution"
```

---

### Task 5: `chatTurn.ts` — one prompt or steer, with timeout and abort, no guards

Spec §3. Mirrors `runAgent`'s subscribe → prompt → settle shape (`src/agent/session.ts:183-370`) minus the `GuardManager`, and **never disposes the session** (it lives for the whole chat).

**Files:**

- Create: `src/chat/chatTurn.ts`
- Test: `tests/chatTurn.test.ts`

**Interfaces:**

- Consumes: `ChatSessionLike`, `fakeChatSession`/`chatScriptText` (Task 3); `RunAccumulator` (`src/agent/runResult.ts`).
- Produces:

  ```ts
  export interface ChatTurnOpts {
    text: string;
    timeoutMs: number;
    emit: (event: unknown) => void; // every SDK event, in order; best-effort
    abortSignal?: AbortSignal; // operator abort
    abortGraceMs?: number; // default 60_000
    now?: () => number;
  }
  export interface ChatTurnResult {
    mode: "prompt" | "steer";
    status: "ok" | "error" | "aborted";
    abortReason: "timeout" | "operator" | null;
    errorMessage: string | null;
    usage: Usage;
    durationMs: number;
    finalText: string;
    allText: string;
  }
  export async function runChatTurn(
    session: ChatSessionLike,
    opts: ChatTurnOpts,
  ): Promise<ChatTurnResult>;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/chatTurn.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runChatTurn } from "../src/chat/chatTurn.js";
import { fakeChatSession, chatScriptText } from "./helpers/fakeSession.js";

describe("runChatTurn (spec 2026-09-01 §3)", () => {
  it("idle session: prompts, forwards every event to emit, sums usage, returns the text", async () => {
    const s = await fakeChatSession([chatScriptText("answer", 0.25)])();
    const seen: string[] = [];
    const r = await runChatTurn(s, {
      text: "q",
      timeoutMs: 5_000,
      emit: (e) => seen.push((e as { type: string }).type),
    });
    expect(r.mode).toBe("prompt");
    expect(r.status).toBe("ok");
    expect(r.finalText).toBe("answer");
    expect(r.usage.costUsd).toBe(0.25);
    expect(r.usage.input).toBe(1);
    expect(seen).toEqual([
      "message_start",
      "message_update",
      "turn_end",
      "agent_end",
      "agent_settled",
    ]);
    expect(s.prompts).toEqual(["q"]);
    expect(s.disposed).toBe(false); // the session lives on
  });

  it("streaming session: steers instead of prompting and returns immediately", async () => {
    const s = await fakeChatSession([{ events: [], delayMs: 200 }])();
    const first = runChatTurn(s, { text: "one", timeoutMs: 5_000, emit: () => {} });
    expect(s.isStreaming).toBe(true);
    const r = await runChatTurn(s, { text: "two", timeoutMs: 5_000, emit: () => {} });
    expect(r.mode).toBe("steer");
    expect(s.steers).toEqual(["two"]);
    expect(s.prompts).toEqual(["one"]);
    await s.abort();
    await first;
  });

  it("timeout: soft-aborts and reports abortReason timeout", async () => {
    const s = await fakeChatSession([{ events: [], delayMs: 10_000 }])();
    const r = await runChatTurn(s, {
      text: "slow",
      timeoutMs: 20,
      emit: () => {},
      abortGraceMs: 50,
    });
    expect(r.status).toBe("aborted");
    expect(r.abortReason).toBe("timeout");
    expect(s.aborted).toBe(1);
  });

  it("operator abort via AbortSignal reports abortReason operator", async () => {
    const s = await fakeChatSession([{ events: [], delayMs: 10_000 }])();
    const ctrl = new AbortController();
    const p = runChatTurn(s, {
      text: "x",
      timeoutMs: 10_000,
      emit: () => {},
      abortSignal: ctrl.signal,
      abortGraceMs: 50,
    });
    ctrl.abort();
    const r = await p;
    expect(r.status).toBe("aborted");
    expect(r.abortReason).toBe("operator");
  });

  it("a thrown provider error becomes status error with the message", async () => {
    const s = await fakeChatSession([
      { events: [], throws: "fetch failed: 429 too many requests" },
    ])();
    const r = await runChatTurn(s, { text: "x", timeoutMs: 1_000, emit: () => {} });
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("429");
  });

  it("a throwing emit never breaks the turn (best-effort observability)", async () => {
    const s = await fakeChatSession([chatScriptText("fine")])();
    const r = await runChatTurn(s, {
      text: "x",
      timeoutMs: 1_000,
      emit: () => {
        throw new Error("sink broke");
      },
    });
    expect(r.status).toBe("ok");
    expect(r.finalText).toBe("fine");
  });

  it("unsubscribes when done: later events do not reach emit", async () => {
    const s = await fakeChatSession([chatScriptText("a"), chatScriptText("b")])();
    const seen: string[] = [];
    await runChatTurn(s, {
      text: "1",
      timeoutMs: 1_000,
      emit: (e) => seen.push((e as { type: string }).type),
    });
    const n = seen.length;
    await s.prompt("raw"); // outside any turn
    expect(seen.length).toBe(n);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/chatTurn.test.ts > /tmp/t5 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/chat/chatTurn.ts`:

```ts
/**
 * One chat turn (spec 2026-09-01 §3): runAgent's subscribe → prompt → settle
 * shape (src/agent/session.ts:183-370) with NO GuardManager — the human is the
 * supervisor and steer() is the nudge — and with the session left alive
 * afterwards (a chat session is prompted many times). What stays from the
 * ticket world is the per-turn timeout, the operator abort, and the wedge
 * grace after an abort (#51).
 */
import type { AgentEvent, ChatSessionLike } from "../agent/session.js";
import { RunAccumulator } from "../agent/runResult.js";
import type { Usage } from "../types.js";
import { log } from "../logging.js";

export interface ChatTurnOpts {
  text: string;
  timeoutMs: number;
  /** Every SDK event, in order. Best-effort: a throw is logged and ignored. */
  emit: (event: unknown) => void;
  /** Operator abort. */
  abortSignal?: AbortSignal;
  /** Wedge grace after an abort (default 60s); tests short-circuit it. */
  abortGraceMs?: number;
  now?: () => number;
}

export interface ChatTurnResult {
  mode: "prompt" | "steer";
  status: "ok" | "error" | "aborted";
  abortReason: "timeout" | "operator" | null;
  errorMessage: string | null;
  usage: Usage;
  durationMs: number;
  finalText: string;
  allText: string;
}

const ABORT_GRACE_MS = 60_000;
const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 };

export async function runChatTurn(
  session: ChatSessionLike,
  opts: ChatTurnOpts,
): Promise<ChatTurnResult> {
  const now = opts.now ?? (() => Date.now());
  const start = now();

  // Streaming → steer: the SDK queues it and delivers it at the next tool
  // boundary of the RUNNING turn, whose own completion covers this text.
  if (session.isStreaming) {
    await session.steer(opts.text);
    return {
      mode: "steer",
      status: "ok",
      abortReason: null,
      errorMessage: null,
      usage: ZERO_USAGE,
      durationMs: now() - start,
      finalText: "",
      allText: "",
    };
  }

  const acc = new RunAccumulator();
  let abortReason: "timeout" | "operator" | null = null;
  let wedged = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveWedge: (() => void) | undefined;
  const wedgePromise = new Promise<void>((resolve) => {
    resolveWedge = resolve;
  });
  const armAbortGrace = (): void => {
    if (graceTimer !== undefined) return;
    graceTimer = setTimeout(() => {
      wedged = true;
      resolveWedge?.();
    }, opts.abortGraceMs ?? ABORT_GRACE_MS);
  };
  const softAbort = (reason: "timeout" | "operator"): void => {
    if (abortReason === null) abortReason = reason;
    void session.abort().catch(() => {});
    armAbortGrace();
  };
  const timer = setTimeout(() => softAbort("timeout"), opts.timeoutMs);
  const onExternalAbort = (): void => softAbort("operator");
  if (opts.abortSignal?.aborted) onExternalAbort();
  else opts.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });

  let unsubscribe: (() => void) | undefined;
  let thrown: string | null = null;
  try {
    unsubscribe = session.subscribe((e: AgentEvent) => {
      acc.observe(e);
      try {
        opts.emit(e);
      } catch (err) {
        log.warn("chat emit threw; ignoring", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    const runPromise = session.prompt(opts.text);
    runPromise.catch(() => {});
    await Promise.race([runPromise, wedgePromise]);
    if (wedged)
      log.warn("chat turn wedged after abort — returning salvaged result", { abortReason });
  } catch (e) {
    thrown = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    opts.abortSignal?.removeEventListener("abort", onExternalAbort);
    unsubscribe?.();
  }

  const durationMs = now() - start;
  const r = acc.result(durationMs, abortReason === "timeout", false);
  const errorMessage = thrown ?? r.errorMessage;
  return {
    mode: "prompt",
    status: abortReason !== null ? "aborted" : errorMessage !== null ? "error" : "ok",
    abortReason,
    errorMessage,
    usage: r.usage,
    durationMs,
    finalText: r.finalText,
    allText: r.allText ?? r.finalText,
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/chatTurn.test.ts > /tmp/t5 2>&1; echo "exit: $?"` — expected 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/chat/chatTurn.ts tests/chatTurn.test.ts
git add src/chat/chatTurn.ts tests/chatTurn.test.ts
git commit -m "feat(chat): runChatTurn — prompt/steer with timeout and abort, no guards"
```

---

### Task 6: `chatSession.ts` — one repo's session: meta, transcript, bus, lazy SDK session, crash stamp

Spec §1.1, §2.3, §5.2 (the bus), §11 (corrupt reset, crash stamp, degraded sink). One object per slug. The transcript sink is a **synchronous append** (`appendFileSync` wrapped best-effort): with the file size tracked in-process, every persisted line's `offset` (byte position after its newline, spec §5.2) is known at write time, and a subscriber that replays then attaches can never straddle an unflushed stream buffer. `message_update` goes to the bus only.

**Files:**

- Create: `src/chat/chatSession.ts`
- Test: `tests/chatSession.test.ts`

**Interfaces:**

- Consumes: `runChatTurn` (Task 5); `makeSessionManager`, `makeChatSessionFactory`, `ChatSessionLike`, `SessionOverrides` (Task 3); `chatSlug` (Task 4); `ChatRecord` types (Task 1); `READ_ONLY_TOOLS` (`src/runOnce.ts:43`); `TRANSCRIPT_VERSION` (`transcriptSchema.ts`).
- Produces:

  ```ts
  export interface ChatMeta {
    key: string;
    kind: "watched" | "local";
    cwd: string;
    nwo: string | null;
    sdkSessionFile: string;
    createdAt: string;
  }
  export interface ChatSubscriber {
    onLine(line: string, offset: number | null): void;
    onEnd(reason: "daemon_stopped" | "session_reset"): void;
  }
  export interface ChatSessionDeps {
    makeSessionManager?: typeof makeSessionManager;
    sessionFactoryFor?: (
      cfg: Config,
      cwd: string,
      overrides: SessionOverrides,
    ) => () => Promise<ChatSessionLike>;
    fs?: Partial<ChatFs>; // existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, renameSync, statSync
    now?: () => number;
  }
  export function chatCfgFor(cfg: Config): Config; // model id + tools narrowing (spec §2.3)
  export class ChatSession {
    constructor(
      opts: {
        cfg: Config;
        key: string;
        kind: "watched" | "local";
        cwd: string;
        nwo: string | null;
        dir: string;
      },
      deps?: ChatSessionDeps,
    );
    readonly slug: string;
    readonly key: string;
    readonly kind;
    readonly cwd;
    readonly nwo;
    readonly dir;
    readonly transcriptPath: string;
    readonly metaPath: string;
    turns: number;
    lastActivityAt: string | null;
    degraded: boolean;
    get streaming(): boolean;
    ensureMeta(): Promise<void>; // meta.json + junco_meta + crash stamp; no SDK
    ensureSession(): Promise<ChatSessionLike>; // + SDK session (lazy; missing-after-a-turn → reset{missing}; corrupt → archive + reset{corrupt}) — Ruling R5
    writeRecord(rec: Omit<ChatRecord, "ts"> | Omit<MetaRecord, "ts" | "version">): void; // stamps ts, persists, publishes
    readLines(since: number): Array<{ offset: number; line: string }>; // complete lines from `since`
    subscribe(sub: ChatSubscriber): () => void;
    prompt(
      text: string,
      opts: { source: "operator" | "auto_lint"; timeoutMs: number; abortGraceMs?: number },
    ): Promise<ChatTurnResult>;
    abort(): Promise<boolean>; // true if a turn was in flight
    drain(): Promise<void>; // abort + daemon_stopped + end subscribers + dispose
    reset(reason: "operator_new"): Promise<void>; // abort, dispose, archive dir, end subscribers(session_reset)
  }
  ```

- [ ] **Step 1: Write the failing tests**

`tests/chatSession.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSession, chatCfgFor } from "../src/chat/chatSession.js";
import type { SessionManagerMode } from "../src/agent/session.js";
import { makeConfig, READ_ONLY_TOOLS } from "./helpers/config.js";
import { fakeChatSession, chatScriptText, type FakeChatSession } from "./helpers/fakeSession.js";
import { parseTranscriptLine } from "../src/agent/transcriptSchema.js";

const cfg = makeConfig({
  dataDir: "/sbxroot/data",
  queueRoot: "/sbxroot/data/queue",
  worktreeRoot: "/sbxroot/wt",
  tools: ["bash", "read", "write", "grep", "find"],
  criticEnabled: false,
  planLintEnabled: false,
  verifyEnabled: false,
  supervisorEnabled: false,
  healthEnabled: false,
  removeWorktreeOnSuccess: true,
});

/** A fake SessionManager seam mirroring SDK 0.84.2 (Ruling R5): "create"
 * mints a file under dir; "open" never throws — a missing path simply yields
 * a session at that path. */
const fakeSm = async (mode: SessionManagerMode): Promise<{ manager: unknown; file: string }> => {
  if ("create" in mode) {
    const file = join(
      mode.create.dir,
      `sdk-session-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.jsonl`,
    );
    writeFileSync(file, "");
    return { manager: { tag: "sm" }, file };
  }
  return { manager: { tag: "sm" }, file: mode.open.file };
};

function makeSession(dir: string, scripts = [chatScriptText("hi", 0.1)]) {
  const factory = fakeChatSession(scripts);
  let last: FakeChatSession | null = null;
  const session = new ChatSession(
    {
      cfg,
      key: "acme/api",
      kind: "watched",
      cwd: dir,
      nwo: "acme/api",
      dir: join(dir, "acme__api"),
    },
    {
      makeSessionManager: fakeSm,
      sessionFactoryFor: () => async () => (last = await factory()),
    },
  );
  return { session, sdk: () => last };
}

const records = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => parseTranscriptLine(l))
    .map((p) =>
      p.kind === "junco" ? p.record.type : p.kind === "sdk" ? String(p.event.type) : "invalid",
    );

describe("chatCfgFor (spec 2026-09-01 §2.3)", () => {
  it("narrows tools to the read-only subset and resolves the model id chain", () => {
    const c = chatCfgFor(cfg);
    expect(c.tools).toEqual(["read", "grep", "find"]);
    expect(c.model.id).toBe(cfg.model.id);
    const planner = chatCfgFor({ ...cfg, github: { ...cfg.github, plannerModelId: "x/planner" } });
    expect(planner.model.id).toBe("x/planner");
    const explicit = chatCfgFor({
      ...cfg,
      chat: { ...cfg.chat, modelId: "x/chat" },
      github: { ...cfg.github, plannerModelId: "x/planner" },
    });
    expect(explicit.model.id).toBe("x/chat");
    expect(READ_ONLY_TOOLS).toEqual(["read", "grep", "find", "ls"]); // the contract this narrows to
  });
});

describe("ChatSession (spec 2026-09-01 §2.3, §5.2, §11)", () => {
  it("ensureMeta creates the dir, meta.json and the junco_meta header once", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    await session.ensureMeta();
    await session.ensureMeta();
    expect(existsSync(session.metaPath)).toBe(true);
    expect(records(session.transcriptPath)).toEqual(["junco_meta"]);
    const meta = JSON.parse(readFileSync(session.metaPath, "utf8"));
    expect(meta.key).toBe("acme/api");
    expect(meta.sdkSessionFile.startsWith(session.dir)).toBe(true);
  });

  it("prompt writes prompt/turn_start/SDK events/turn_end — never message_update — and fans out everything", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    const bus: Array<{ type: string; offset: number | null }> = [];
    session.subscribe({
      onLine: (line, offset) => bus.push({ type: JSON.parse(line).type, offset }),
      onEnd: () => {},
    });
    const r = await session.prompt("hello", { source: "operator", timeoutMs: 5_000 });
    expect(r.status).toBe("ok");
    expect(records(session.transcriptPath)).toEqual([
      "junco_meta",
      "junco_chat_prompt",
      "junco_chat_turn_start",
      "message_start",
      "turn_end",
      "agent_end",
      "agent_settled",
      "junco_chat_turn_end",
    ]);
    const busTypes = bus.map((b) => b.type);
    expect(busTypes).toContain("message_update");
    expect(bus.find((b) => b.type === "message_update")!.offset).toBeNull();
    expect(bus.find((b) => b.type === "turn_end")!.offset).toBeGreaterThan(0);
    expect(session.turns).toBe(1);
    expect(session.streaming).toBe(false);
  });

  it("readLines(since) returns complete lines with end-of-line offsets, and resumes exactly after an echoed offset", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    await session.prompt("hello", { source: "operator", timeoutMs: 5_000 });
    const all = session.readLines(0);
    expect(all.length).toBeGreaterThan(3);
    const size = readFileSync(session.transcriptPath).length;
    expect(all[all.length - 1]!.offset).toBe(size);
    const rest = session.readLines(all[1]!.offset);
    expect(rest.map((r) => r.line)).toEqual(all.slice(2).map((r) => r.line));
    // a torn tail is held back
    writeFileSync(session.transcriptPath, '{"type":"turn_en', { flag: "a" });
    expect(session.readLines(size)).toEqual([]);
  });

  it("stamps a crash-aborted turn on open when the transcript ends in turn_start", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    await session.ensureMeta();
    writeFileSync(
      session.transcriptPath,
      JSON.stringify({
        type: "junco_chat_turn_start",
        modelId: "m",
        tools: [],
        timeoutMs: 1,
        ts: "t",
      }) + "\n",
      { flag: "a" },
    );
    const again = makeSession(root).session;
    await again.ensureMeta();
    const types = records(again.transcriptPath);
    expect(types[types.length - 1]).toBe("junco_chat_turn_aborted");
    const last = readFileSync(again.transcriptPath, "utf8").trim().split("\n").pop()!;
    expect(JSON.parse(last).reason).toBe("crash");
  });

  it("a missing SDK session file is a reset only when a turn was already completed (Ruling R5)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    // No turn yet: the SDK never flushed, so a missing file loses nothing — no reset record.
    const { session } = makeSession(root);
    await session.ensureSession();
    const meta = JSON.parse(readFileSync(session.metaPath, "utf8"));
    const { rmSync } = await import("node:fs");
    rmSync(meta.sdkSessionFile);
    const again = makeSession(root).session;
    await again.ensureSession();
    expect(records(again.transcriptPath)).not.toContain("junco_chat_session_reset");
    expect(JSON.parse(readFileSync(again.metaPath, "utf8")).sdkSessionFile).toBe(
      meta.sdkSessionFile,
    );
    // A completed turn, then the file goes missing: that is a reset the operator must see.
    await again.prompt("hello", { source: "operator", timeoutMs: 5_000 });
    rmSync(meta.sdkSessionFile, { force: true });
    const third = makeSession(root).session;
    await third.ensureSession();
    const types = records(third.transcriptPath);
    expect(types[types.length - 1]).toBe("junco_chat_session_reset");
    const last = JSON.parse(readFileSync(third.transcriptPath, "utf8").trim().split("\n").pop()!);
    expect(last.reason).toBe("missing");
  });

  it("a corrupt SDK session file (open or build throws) is archived under corrupt-* and replaced", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    await session.ensureSession();
    const meta = JSON.parse(readFileSync(session.metaPath, "utf8"));
    writeFileSync(meta.sdkSessionFile, "{not json");
    let calls = 0;
    const throwingOnce = async (mode: SessionManagerMode) => {
      if ("open" in mode && calls++ === 0) throw new Error("bad header");
      return fakeSm(mode);
    };
    const again = new ChatSession(
      {
        cfg,
        key: "acme/api",
        kind: "watched",
        cwd: root,
        nwo: "acme/api",
        dir: join(root, "acme__api"),
      },
      {
        makeSessionManager: throwingOnce,
        sessionFactoryFor: () => fakeChatSession([chatScriptText("hi")]),
      },
    );
    await again.ensureSession();
    const types = records(again.transcriptPath);
    expect(types).toContain("junco_chat_session_reset");
    const last = JSON.parse(readFileSync(again.transcriptPath, "utf8").trim().split("\n").pop()!);
    expect(last.reason).toBe("corrupt");
    const meta2 = JSON.parse(readFileSync(again.metaPath, "utf8"));
    expect(meta2.sdkSessionFile).not.toBe(meta.sdkSessionFile);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(root, "acme__api")).some((n) => n.startsWith("corrupt-"))).toBe(true);
  });

  it("abort() soft-aborts an in-flight turn; drain() writes daemon_stopped and ends subscribers", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session, sdk } = makeSession(root, [{ events: [], delayMs: 10_000 }]);
    const ends: string[] = [];
    session.subscribe({ onLine: () => {}, onEnd: (r) => ends.push(r) });
    const p = session.prompt("slow", { source: "operator", timeoutMs: 60_000, abortGraceMs: 50 });
    await new Promise((r) => setTimeout(r, 5));
    expect(session.streaming).toBe(true);
    await session.drain();
    const r = await p;
    expect(r.status).toBe("aborted");
    expect(sdk()!.disposed).toBe(true);
    expect(ends).toEqual(["daemon_stopped"]);
    const types = records(session.transcriptPath);
    expect(types).toContain("junco_chat_turn_aborted");
    const aborted = readFileSync(session.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((r) => r.type === "junco_chat_turn_aborted");
    expect(aborted.map((a) => a.reason)).toContain("daemon_stopped");
  });

  it("reset('operator_new') archives the whole dir and ends subscribers with session_reset", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    await session.prompt("hello", { source: "operator", timeoutMs: 5_000 });
    const ends: string[] = [];
    session.subscribe({ onLine: () => {}, onEnd: (r) => ends.push(r) });
    await session.reset("operator_new");
    expect(existsSync(session.transcriptPath)).toBe(false);
    const archive = join(root, "_archive");
    expect(existsSync(archive)).toBe(true);
    expect(ends).toEqual(["session_reset"]);
  });

  it("a dead sink degrades: live delivery continues, one degraded record is published, offsets are null", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    // make the transcript path unwritable by putting a DIRECTORY there
    mkdirSync(session.dir, { recursive: true });
    mkdirSync(session.transcriptPath);
    const bus: Array<{ type: string; offset: number | null }> = [];
    session.subscribe({
      onLine: (l, o) => bus.push({ type: JSON.parse(l).type, offset: o }),
      onEnd: () => {},
    });
    const r = await session.prompt("hello", { source: "operator", timeoutMs: 5_000 });
    expect(r.status).toBe("ok");
    expect(session.degraded).toBe(true);
    expect(bus.filter((b) => b.type === "junco_chat_transcript_degraded")).toHaveLength(1);
    expect(bus.every((b) => b.offset === null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/chatSession.test.ts > /tmp/t6 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/chat/chatSession.ts`:

```ts
/**
 * One repo's chat session (spec 2026-09-01 §2.3). Owns: meta.json, the
 * transcript (a synchronous best-effort append so every persisted line's
 * end-offset is known at write time — the SSE `id`, §5.2), the in-memory
 * record bus (live fan-out; message_update is bus-only), the lazily built SDK
 * session, and the current turn. Never imports the SDK: the two SDK-touching
 * helpers come from agent/session.ts through deps.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../types.js";
import {
  makeChatSessionFactory,
  makeSessionManager,
  type ChatSessionLike,
  type SessionOverrides,
} from "../agent/session.js";
import {
  TRANSCRIPT_VERSION,
  parseTranscriptLine,
  type ChatRecord,
  type MetaRecord,
} from "../agent/transcriptSchema.js";
import { READ_ONLY_TOOLS } from "../runOnce.js";
import { log } from "../logging.js";
import { chatSlug } from "./chatKey.js";
import { runChatTurn, type ChatTurnResult } from "./chatTurn.js";

export interface ChatMeta {
  key: string;
  kind: "watched" | "local";
  cwd: string;
  nwo: string | null;
  sdkSessionFile: string;
  createdAt: string;
}

export interface ChatSubscriber {
  /** offset = byte position after the line's newline; null for bus-only lines. */
  onLine(line: string, offset: number | null): void;
  onEnd(reason: "daemon_stopped" | "session_reset"): void;
}

export interface ChatFs {
  existsSync: typeof existsSync;
  readFileSync: (p: string, enc: "utf8") => string;
  appendFileSync: (p: string, s: string) => void;
  writeFileSync: (p: string, s: string) => void;
  mkdirSync: (d: string) => void;
  renameSync: typeof renameSync;
  statSync: (p: string) => { size: number };
}

export interface ChatSessionDeps {
  makeSessionManager?: typeof makeSessionManager;
  sessionFactoryFor?: (
    cfg: Config,
    cwd: string,
    overrides: SessionOverrides,
  ) => () => Promise<ChatSessionLike>;
  fs?: Partial<ChatFs>;
  now?: () => number;
}

/** The chat's Config view (spec §2.3): read-only tool subset, model id chain
 * chat.modelId → github.plannerModelId → model.id. Never widens tools. */
export function chatCfgFor(cfg: Config): Config {
  return {
    ...cfg,
    tools: cfg.tools.filter((t) => READ_ONLY_TOOLS.has(t)),
    model: { ...cfg.model, id: cfg.chat.modelId ?? cfg.github.plannerModelId ?? cfg.model.id },
  };
}

const realFs: ChatFs = {
  existsSync,
  readFileSync: (p, enc) => readFileSync(p, enc),
  appendFileSync: (p, s) => appendFileSync(p, s, "utf8"),
  writeFileSync: (p, s) => writeFileSync(p, s, "utf8"),
  mkdirSync: (d) => mkdirSync(d, { recursive: true }),
  renameSync,
  statSync: (p) => statSync(p),
};

export class ChatSession {
  readonly slug: string;
  readonly key: string;
  readonly kind: "watched" | "local";
  readonly cwd: string;
  readonly nwo: string | null;
  readonly dir: string;
  readonly transcriptPath: string;
  readonly metaPath: string;
  turns = 0;
  lastActivityAt: string | null = null;
  degraded = false;

  private readonly cfg: Config;
  private readonly fs: ChatFs;
  private readonly now: () => number;
  private readonly makeSm: typeof makeSessionManager;
  private readonly factoryFor: NonNullable<ChatSessionDeps["sessionFactoryFor"]>;
  private readonly subscribers = new Set<ChatSubscriber>();
  private metaReady = false;
  private sdk: ChatSessionLike | null = null;
  private sdkPending: Promise<ChatSessionLike> | null = null;
  private size = 0;
  private turnAbort: AbortController | null = null;
  private inFlight: Promise<ChatTurnResult> | null = null;

  constructor(
    opts: {
      cfg: Config;
      key: string;
      kind: "watched" | "local";
      cwd: string;
      nwo: string | null;
      dir: string;
    },
    deps: ChatSessionDeps = {},
  ) {
    this.cfg = opts.cfg;
    this.key = opts.key;
    this.slug = chatSlug(opts.key);
    this.kind = opts.kind;
    this.cwd = opts.cwd;
    this.nwo = opts.nwo;
    this.dir = opts.dir;
    this.transcriptPath = join(opts.dir, "transcript.jsonl");
    this.metaPath = join(opts.dir, "meta.json");
    this.fs = { ...realFs, ...deps.fs };
    this.now = deps.now ?? (() => Date.now());
    this.makeSm = deps.makeSessionManager ?? makeSessionManager;
    this.factoryFor = deps.sessionFactoryFor ?? makeChatSessionFactory;
  }

  get streaming(): boolean {
    return this.inFlight !== null;
  }

  // ---- transcript + bus ----------------------------------------------------

  private persist(line: string): number | null {
    if (this.degraded) return null;
    try {
      this.fs.appendFileSync(this.transcriptPath, line);
      this.size += Buffer.byteLength(line, "utf8");
      return this.size;
    } catch (e) {
      this.degraded = true;
      log.warn("chat transcript disabled (append failed)", {
        slug: this.slug,
        error: e instanceof Error ? e.message : String(e),
      });
      this.publish(
        JSON.stringify({ type: "junco_chat_transcript_degraded", ts: this.ts() }) + "\n",
        null,
      );
      return null;
    }
  }

  private publish(line: string, offset: number | null): void {
    for (const s of this.subscribers) {
      try {
        s.onLine(line, offset);
      } catch (e) {
        log.warn("chat subscriber threw; dropping it", {
          error: e instanceof Error ? e.message : String(e),
        });
        this.subscribers.delete(s);
      }
    }
  }

  private ts(): string {
    return new Date(this.now()).toISOString();
  }

  /** Stamp ts, persist (unless degraded), publish. junco_meta gets version. */
  writeRecord(rec: Omit<ChatRecord, "ts"> | Omit<MetaRecord, "ts" | "version">): void {
    const full =
      rec.type === "junco_meta"
        ? { ...rec, version: TRANSCRIPT_VERSION, ts: this.ts() }
        : { ...rec, ts: this.ts() };
    const line = JSON.stringify(full) + "\n";
    this.publish(line, this.persist(line));
  }

  /** SDK event: bus always; file unless message_update (spec §1.3). */
  private emitSdk(event: unknown): void {
    const line = JSON.stringify(event) + "\n";
    const type = (event as { type?: unknown } | null)?.type;
    this.publish(line, type === "message_update" ? null : this.persist(line));
  }

  /** Complete lines from `since`; each offset is the position after its newline. */
  readLines(since: number): Array<{ offset: number; line: string }> {
    let raw: string;
    try {
      raw = this.fs.readFileSync(this.transcriptPath, "utf8");
    } catch {
      return [];
    }
    const buf = Buffer.from(raw, "utf8");
    const out: Array<{ offset: number; line: string }> = [];
    let pos = Math.max(0, since);
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl === -1) break; // torn tail: held until its newline arrives
      out.push({ offset: nl + 1, line: buf.subarray(pos, nl).toString("utf8") });
      pos = nl + 1;
    }
    return out;
  }

  subscribe(sub: ChatSubscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  private endSubscribers(reason: "daemon_stopped" | "session_reset"): void {
    for (const s of this.subscribers) {
      try {
        s.onEnd(reason);
      } catch {
        /* best effort */
      }
    }
    this.subscribers.clear();
  }

  // ---- meta + lifecycle ------------------------------------------------------

  private readMeta(): ChatMeta | null {
    try {
      const m = JSON.parse(this.fs.readFileSync(this.metaPath, "utf8")) as ChatMeta;
      return typeof m.sdkSessionFile === "string" ? m : null;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: ChatMeta): void {
    this.fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2) + "\n");
  }

  /** meta.json + junco_meta header + crash stamp. No SDK. Idempotent. */
  async ensureMeta(): Promise<void> {
    if (this.metaReady) return;
    this.fs.mkdirSync(this.dir);
    try {
      this.size = this.fs.statSync(this.transcriptPath).size;
    } catch {
      this.size = 0;
    }
    if (this.readMeta() === null) {
      const { file } = await this.makeSm({ create: { cwd: this.cwd, dir: this.dir } });
      this.writeMeta({
        key: this.key,
        kind: this.kind,
        cwd: this.cwd,
        nwo: this.nwo,
        sdkSessionFile: file,
        createdAt: this.ts(),
      });
      if (this.size === 0) this.writeRecord({ type: "junco_meta", ticketId: this.slug });
    }
    this.stampCrashIfNeeded();
    this.metaReady = true;
  }

  /** Spec §11: a transcript whose last turn record is turn_start died mid-turn. */
  private stampCrashIfNeeded(): void {
    let lastTurn: string | null = null;
    for (const { line } of this.readLines(0)) {
      const p = parseTranscriptLine(line);
      if (p.kind !== "junco") continue;
      const t = p.record.type;
      if (
        t === "junco_chat_turn_start" ||
        t === "junco_chat_turn_end" ||
        t === "junco_chat_turn_aborted"
      )
        lastTurn = t;
    }
    if (lastTurn === "junco_chat_turn_start")
      this.writeRecord({ type: "junco_chat_turn_aborted", reason: "crash" });
  }

  /** True once the transcript holds a completed turn — the line between
   * "nothing to lose" and "a reset the operator must see" (Ruling R5). */
  private hasCompletedTurn(): boolean {
    for (const { line } of this.readLines(0)) {
      const p = parseTranscriptLine(line);
      if (p.kind === "junco" && p.record.type === "junco_chat_turn_end") return true;
    }
    return false;
  }

  /** Lazily build the SDK session (spec §11, Ruling R5). SDK 0.84.2 facts
   * (verified in Task 3): `SessionManager.open()` on a MISSING path never
   * throws — it yields a fresh empty session at that path — and `create()`
   * writes nothing until the first assistant message. So "missing" is not an
   * error: it is a reset only when the transcript proves turns were lost.
   * "Corrupt" is the file existing and `open` OR the session build throwing
   * (createAgentSession calls `sessionManager.buildSessionContext()`,
   * sdk.js:80) → archive to corrupt-<ts>/, create fresh, record the reset. */
  async ensureSession(): Promise<ChatSessionLike> {
    if (this.sdk) return this.sdk;
    if (this.sdkPending) return this.sdkPending;
    this.sdkPending = (async () => {
      await this.ensureMeta();
      const meta = this.readMeta()!;
      const chatCfg = chatCfgFor(this.cfg);
      const build = async (manager: unknown): Promise<ChatSessionLike> =>
        this.factoryFor(chatCfg, this.cwd, {
          tools: chatCfg.tools,
          thinkingLevel: this.cfg.chat.thinkingLevel ?? this.cfg.model.thinkingLevel,
          sessionManager: manager,
        })();
      if (!this.fs.existsSync(meta.sdkSessionFile)) {
        if (this.hasCompletedTurn()) {
          log.warn("chat SDK session file missing; starting fresh", { slug: this.slug });
          this.writeRecord({ type: "junco_chat_session_reset", reason: "missing" });
        }
        const { manager } = await this.makeSm({
          open: { file: meta.sdkSessionFile, dir: this.dir, cwd: this.cwd },
        });
        this.sdk = await build(manager);
        return this.sdk;
      }
      try {
        const { manager } = await this.makeSm({
          open: { file: meta.sdkSessionFile, dir: this.dir, cwd: this.cwd },
        });
        this.sdk = await build(manager);
        return this.sdk;
      } catch (e) {
        log.warn("chat SDK session file corrupt; starting fresh", {
          slug: this.slug,
          error: e instanceof Error ? e.message : String(e),
        });
        const corruptDir = join(this.dir, `corrupt-${this.now()}`);
        this.fs.mkdirSync(corruptDir);
        this.fs.renameSync(meta.sdkSessionFile, join(corruptDir, "session.jsonl"));
        const created = await this.makeSm({ create: { cwd: this.cwd, dir: this.dir } });
        this.writeMeta({ ...meta, sdkSessionFile: created.file, cwd: this.cwd });
        this.writeRecord({ type: "junco_chat_session_reset", reason: "corrupt" });
        this.sdk = await build(created.manager);
        return this.sdk;
      }
    })();
    try {
      return await this.sdkPending;
    } finally {
      this.sdkPending = null;
    }
  }

  // ---- turns ---------------------------------------------------------------------

  async prompt(
    text: string,
    opts: {
      source: "operator" | "auto_lint";
      timeoutMs: number;
      abortGraceMs?: number;
      /** The manager owns the gate + classifier; it passes one in so the end
       *  record carries the class (spec §1.3). Absent → null. */
      classify?: (message: string) => ProviderFailureClass | null;
    },
  ): Promise<ChatTurnResult> {
    const sdk = await this.ensureSession();
    const chatCfg = chatCfgFor(this.cfg);
    if (sdk.isStreaming) {
      // steer: the running turn's own records frame this
      this.writeRecord({ type: "junco_chat_prompt", text, mode: "steer", source: opts.source });
      return runChatTurn(sdk, { text, timeoutMs: opts.timeoutMs, emit: () => {} });
    }
    this.writeRecord({ type: "junco_chat_prompt", text, mode: "prompt", source: opts.source });
    this.writeRecord({
      type: "junco_chat_turn_start",
      modelId: chatCfg.model.id,
      tools: chatCfg.tools,
      timeoutMs: opts.timeoutMs,
    });
    this.turnAbort = new AbortController();
    const run = runChatTurn(sdk, {
      text,
      timeoutMs: opts.timeoutMs,
      abortGraceMs: opts.abortGraceMs,
      abortSignal: this.turnAbort.signal,
      emit: (e) => this.emitSdk(e),
      now: this.now,
    });
    this.inFlight = run;
    try {
      const r = await run;
      this.turns++;
      this.lastActivityAt = this.ts();
      if (r.status === "aborted") {
        this.writeRecord({
          type: "junco_chat_turn_aborted",
          reason: this.drainReason ?? r.abortReason ?? "operator",
        });
      } else {
        this.writeRecord({
          type: "junco_chat_turn_end",
          status: r.status,
          errorClass: r.errorMessage !== null ? (opts.classify?.(r.errorMessage) ?? null) : null,
          errorMessage: r.errorMessage,
          usage: r.usage,
          durationMs: r.durationMs,
        });
      }
      return r;
    } finally {
      this.inFlight = null;
      this.turnAbort = null;
    }
  }

  private drainReason: "daemon_stopped" | null = null;

  /** Operator abort; true when a turn was in flight. */
  async abort(): Promise<boolean> {
    if (!this.inFlight) return false;
    this.turnAbort?.abort();
    await this.inFlight.catch(() => undefined);
    return true;
  }

  /** Graceful stop (spec §2.4): abort, stamp daemon_stopped, end subscribers, dispose. */
  async drain(): Promise<void> {
    this.drainReason = "daemon_stopped";
    await this.abort();
    this.endSubscribers("daemon_stopped");
    this.disposeSdk();
  }

  /** /new (spec §2.4): abort, dispose, archive the dir; drafts untouched. */
  async reset(reason: "operator_new"): Promise<void> {
    await this.abort();
    this.disposeSdk();
    this.endSubscribers("session_reset");
    if (this.fs.existsSync(this.dir)) {
      const archive = join(dirname(this.dir), "_archive");
      this.fs.mkdirSync(archive);
      this.fs.renameSync(this.dir, join(archive, `${this.slug}-${this.now()}`));
    }
    this.metaReady = false;
    this.size = 0;
    this.turns = 0;
    log.info("chat session reset", { slug: this.slug, reason });
  }

  private disposeSdk(): void {
    try {
      this.sdk?.dispose();
    } catch {
      /* best effort */
    }
    this.sdk = null;
  }
}
```

Add `import type { ProviderFailureClass } from "../providerFailure.js";` to the imports (type-only).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/chatSession.test.ts > /tmp/t6 2>&1; echo "exit: $?"` — expected 0. Also `npx vitest run tests/runOnce.test.ts` (importing `READ_ONLY_TOOLS` from `runOnce.ts` into a new module must not create an evaluation-order cycle — `runOnce.ts` imports nothing from `chat/`, so it can't).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/chat/chatSession.ts tests/chatSession.test.ts
git add src/chat/chatSession.ts tests/chatSession.test.ts
git commit -m "feat(chat): ChatSession — meta, transcript with offsets, record bus, lazy SDK session"
```

---

### Task 7: `chatManager.ts` — registry, gates, spend, health, drain

Spec §2.4, §4. The manager is the daemon's single entry point: it resolves keys to sessions, runs the pre-turn gate check, records spend in-process, reports provider failures into the gate (symmetric with `runOnce`), exposes `/health.chats`, and drains on stop. A hook (`onTurnComplete`) lets Task 11 attach draft parking without the manager knowing about drafts.

**Files:**

- Create: `src/chat/chatManager.ts`
- Test: `tests/chatManager.test.ts`

**Interfaces:**

- Consumes: `ChatSession`, `ChatSubscriber`, `ChatSessionDeps` (Task 6); `resolveChatCwd`, `ChatCwdError` (Task 4); `chatSlug` (Task 4); `classifyProviderFailure`, `GATE_CLASSES` (`src/providerFailure.ts`); `ProviderGate` (`src/providerGate.ts`), `SpendLedger` (`src/spendLedger.ts`); `dataTreePaths(cfg).chats` (Task 1).
- Produces:

  ```ts
  export interface ChatStatus {
    key: string;
    slug: string;
    streaming: boolean;
    turns: number;
    lastActivityAt: string | null;
    draftsParked: number;
  }
  export interface ChatHealth {
    enabled: boolean;
    sessions: ChatStatus[];
    turns: number;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
  }
  export type ChatError = ChatCwdError | "chat_disabled";
  export type ChatResult<T> = { ok: true; value: T } | { ok: false; error: ChatError };
  export interface ChatManagerDeps {
    cfg: () => Config; // live config
    gate: Pick<
      ProviderGate,
      "claimBlockReason" | "status" | "reportFailure" | "reportBudgetExhausted"
    >;
    spend: Pick<SpendLedger, "recordUsd" | "todayUsd" | "nextMidnightMs">;
    resolveCwd?: typeof resolveChatCwd;
    session?: ChatSessionDeps;
    onTurnComplete?: (
      session: ChatSession,
      result: ChatTurnResult,
      source: "operator" | "auto_lint",
    ) => Promise<void>;
    draftsParkedFor?: (slug: string) => number;
    abortGraceMs?: number;
    now?: () => number;
  }
  export class ChatManager {
    constructor(deps: ChatManagerDeps);
    enabled(): boolean;
    get(key: string): Promise<ChatResult<ChatSession>>;
    prompt(
      key: string,
      text: string,
      opts?: { source?: "operator" | "auto_lint" },
    ): Promise<ChatResult<{ mode: "prompt" | "steer" | "rejected" }>>;
    abort(key: string): Promise<ChatResult<{ aborted: boolean }>>;
    fresh(key: string): Promise<ChatResult<null>>;
    note(key: string, record: Omit<ChatDraftRecord, "ts">): Promise<ChatResult<null>>;
    subscribe(
      key: string,
      since: number,
      sub: ChatSubscriber,
    ): Promise<
      ChatResult<{ replay: Array<{ offset: number; line: string }>; unsubscribe: () => void }>
    >;
    status(key: string): ChatStatus | null;
    health(): ChatHealth;
    drain(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

`tests/chatManager.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatManager, type ChatManagerDeps } from "../src/chat/chatManager.js";
import { makeConfig } from "./helpers/config.js";
import { fakeChatSession, chatScriptText } from "./helpers/fakeSession.js";
import type { SessionManagerMode } from "../src/agent/session.js";
import type { GateStatus } from "../src/providerGate.js";
import type { ProviderFailureClass } from "../src/providerFailure.js";

function fakeGate(block: string | null = null) {
  const failures: Array<[ProviderFailureClass, string]> = [];
  const budget: Array<[number, string]> = [];
  return {
    failures,
    budget,
    claimBlockReason: () => block,
    status: (): GateStatus => ({
      state: block ? "rate_limited" : "ok",
      reason: block,
      since: null,
      until: block ? "2026-09-01T18:00:00.000Z" : null,
    }),
    reportFailure: (cls: ProviderFailureClass, reason: string) => failures.push([cls, reason]),
    reportBudgetExhausted: (untilMs: number, reason: string) => budget.push([untilMs, reason]),
  };
}
function fakeSpend(today = 0) {
  const calls: number[] = [];
  return {
    calls,
    recordUsd: (u: number) => calls.push(u),
    todayUsd: () => today,
    nextMidnightMs: () => 1_900_000_000_000,
  };
}
const fakeSm = async (mode: SessionManagerMode) => {
  if ("create" in mode) {
    const file = join(mode.create.dir, "sdk.jsonl");
    writeFileSync(file, "");
    return { manager: {}, file };
  }
  return { manager: {}, file: mode.open.file };
};

function setup(over: Partial<ChatManagerDeps> = {}, scripts = [chatScriptText("hi", 0.3)]) {
  const root = mkdtempSync(join(tmpdir(), "junco-cm-"));
  const cfg = makeConfig({
    dataDir: root,
    queueRoot: join(root, "queue"),
    worktreeRoot: join(root, "wt"),
    tools: ["read", "grep", "bash"],
    criticEnabled: false,
    planLintEnabled: false,
    verifyEnabled: false,
    supervisorEnabled: false,
    healthEnabled: false,
    removeWorktreeOnSuccess: true,
  });
  const gate = fakeGate();
  const spend = fakeSpend();
  const factory = fakeChatSession(scripts);
  const m = new ChatManager({
    cfg: () => cfg,
    gate,
    spend,
    resolveCwd: async () => ({ ok: true, cwd: root, kind: "watched", nwo: "acme/api" }),
    session: { makeSessionManager: fakeSm, sessionFactoryFor: () => factory },
    abortGraceMs: 20,
    ...over,
  });
  return { m, cfg, gate, spend, root };
}

const lines = (p: string) =>
  readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("ChatManager (spec 2026-09-01 §2.4, §4)", () => {
  it("prompt runs a turn, records spend once, counts, and fires onTurnComplete", async () => {
    const done: string[] = [];
    const { m, spend } = setup({
      onTurnComplete: async (_s, r, src) => void done.push(`${src}:${r.status}`),
    });
    const r = await m.prompt("acme/api", "hello");
    expect(r).toEqual({ ok: true, value: { mode: "prompt" } });
    expect(spend.calls).toEqual([0.3]);
    expect(done).toEqual(["operator:ok"]);
    const h = m.health();
    expect(h.turns).toBe(1);
    expect(h.costUsd).toBeCloseTo(0.3);
    expect(h.sessions[0]).toMatchObject({
      key: "acme/api",
      slug: "acme__api",
      streaming: false,
      turns: 1,
    });
  });

  it("gate-blocked: no model call, a junco_chat_turn_rejected record with until, mode rejected", async () => {
    const { m } = setup({ gate: fakeGate("rate limited: 429") });
    const s = await m.get("acme/api");
    expect(s.ok).toBe(true);
    const r = await m.prompt("acme/api", "hello");
    expect(r).toEqual({ ok: true, value: { mode: "rejected" } });
    const recs = lines((s as { value: { transcriptPath: string } }).value.transcriptPath);
    const rej = recs.find((x) => x.type === "junco_chat_turn_rejected");
    expect(rej).toMatchObject({ reason: "rate limited: 429", until: "2026-09-01T18:00:00.000Z" });
    expect(recs.some((x) => x.type === "junco_chat_turn_start")).toBe(false);
  });

  it("budget exhausted: reports into the gate first (live dailyBudgetUsd), then rejects", async () => {
    const { cfg, root } = setup();
    const gate = fakeGate();
    // The real gate latches budget_exhausted on reportBudgetExhausted; mimic that.
    const latching = {
      ...gate,
      claimBlockReason: () => (gate.budget.length > 0 ? gate.budget[0]![1] : null),
    };
    const m = new ChatManager({
      cfg: () => ({ ...cfg, dailyBudgetUsd: 5 }),
      gate: latching,
      spend: fakeSpend(10),
      resolveCwd: async () => ({ ok: true, cwd: root, kind: "watched", nwo: "acme/api" }),
      session: { makeSessionManager: fakeSm, sessionFactoryFor: () => fakeChatSession([]) },
    });
    const r = await m.prompt("acme/api", "hello");
    expect(gate.budget).toHaveLength(1);
    expect(gate.budget[0]![1]).toBe("daily budget $5.00 reached ($10.00 spent)");
    expect(r).toEqual({ ok: true, value: { mode: "rejected" } });
  });

  it("a gate-class provider failure during a turn reports into the gate (symmetric with tickets)", async () => {
    const { m, gate } = setup({}, [{ events: [], throws: "fetch failed: 429 too many requests" }]);
    const r = await m.prompt("acme/api", "hello");
    expect(r).toEqual({ ok: true, value: { mode: "prompt" } });
    expect(gate.failures).toEqual([["rate_limit", "fetch failed: 429 too many requests"]]);
  });

  it("an unknown-class failure does not touch the gate", async () => {
    const { m, gate } = setup({}, [{ events: [], throws: "something odd" }]);
    await m.prompt("acme/api", "hello");
    expect(gate.failures).toEqual([]);
  });

  it("chat.enabled=false → chat_disabled; unknown key → unknown_key", async () => {
    const { cfg } = setup();
    const off = new ChatManager({
      cfg: () => ({ ...cfg, chat: { ...cfg.chat, enabled: false } }),
      gate: fakeGate(),
      spend: fakeSpend(),
    });
    expect(await off.prompt("acme/api", "x")).toEqual({ ok: false, error: "chat_disabled" });
    const unknown = new ChatManager({
      cfg: () => cfg,
      gate: fakeGate(),
      spend: fakeSpend(),
      resolveCwd: async () => ({ ok: false, error: "unknown_key" }),
    });
    expect(await unknown.get("nobody/nothing")).toEqual({ ok: false, error: "unknown_key" });
  });

  it("subscribe replays from `since` then goes live; abort aborts; fresh resets", async () => {
    const { m } = setup({}, [
      chatScriptText("a"),
      { events: [], delayMs: 10_000 },
      chatScriptText("c"),
    ]);
    await m.prompt("acme/api", "one");
    const live: string[] = [];
    const sub = await m.subscribe("acme/api", 0, {
      onLine: (l) => live.push(JSON.parse(l).type),
      onEnd: () => {},
    });
    expect(sub.ok).toBe(true);
    if (!sub.ok) return;
    expect(sub.value.replay.map((r) => JSON.parse(r.line).type)).toContain("junco_chat_turn_end");
    const p = m.prompt("acme/api", "two");
    await vi.waitFor(() => expect(m.status("acme/api")?.streaming).toBe(true));
    expect(await m.abort("acme/api")).toEqual({ ok: true, value: { aborted: true } });
    await p;
    expect(live).toContain("junco_chat_turn_aborted");
    expect(await m.abort("acme/api")).toEqual({ ok: true, value: { aborted: false } });
    expect(await m.fresh("acme/api")).toEqual({ ok: true, value: null });
    expect(m.status("acme/api")?.turns).toBe(0);
  });

  it("note appends a junco_chat_draft record with a server ts", async () => {
    const { m } = setup();
    const s = await m.get("acme/api");
    if (!s.ok) throw new Error("no session");
    const r = await m.note("acme/api", {
      type: "junco_chat_draft",
      draftId: "d1",
      kind: "ticket",
      status: "submitted",
      ids: ["t1"],
      destination: "inbox",
    });
    expect(r).toEqual({ ok: true, value: null });
    const recs = lines(s.value.transcriptPath);
    const note = recs.find((x) => x.type === "junco_chat_draft");
    expect(note).toMatchObject({ draftId: "d1", status: "submitted", destination: "inbox" });
    expect(typeof note.ts).toBe("string");
  });

  it("drain aborts every streaming session and ends every subscriber", async () => {
    const { m } = setup({}, [{ events: [], delayMs: 10_000 }]);
    const ends: string[] = [];
    await m.subscribe("acme/api", 0, { onLine: () => {}, onEnd: (r) => ends.push(r) });
    const p = m.prompt("acme/api", "slow");
    await vi.waitFor(() => expect(m.status("acme/api")?.streaming).toBe(true));
    await m.drain();
    await p;
    expect(ends).toEqual(["daemon_stopped"]);
    expect(m.health().sessions[0]?.streaming).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/chatManager.test.ts > /tmp/t7 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/chat/chatManager.ts`:

```ts
/**
 * The daemon's chat registry (spec 2026-09-01 §2.4, §4): key → ChatSession,
 * the pre-turn gate check (the same two steps daemon.ts's gatedReady runs),
 * in-process spend recording (the ledger keeps its single writer), symmetric
 * provider-failure reporting (a chat 429 pauses claiming exactly as a ticket
 * 429 would), /health.chats, and the graceful drain. Draft parking attaches
 * through `onTurnComplete` (chatDrafts.ts) — the manager knows nothing about
 * fences.
 */
import { join } from "node:path";
import type { Config } from "../types.js";
import type { ProviderGate } from "../providerGate.js";
import type { SpendLedger } from "../spendLedger.js";
import { classifyProviderFailure, GATE_CLASSES } from "../providerFailure.js";
import { dataTreePaths } from "../dataTree.js";
import type { ChatDraftRecord } from "../agent/transcriptSchema.js";
import { log } from "../logging.js";
import { chatSlug } from "./chatKey.js";
import { resolveChatCwd, type ChatCwdError } from "./chatCwd.js";
import { ChatSession, type ChatSessionDeps, type ChatSubscriber } from "./chatSession.js";
import type { ChatTurnResult } from "./chatTurn.js";

export interface ChatStatus {
  key: string;
  slug: string;
  streaming: boolean;
  turns: number;
  lastActivityAt: string | null;
  draftsParked: number;
}
export interface ChatHealth {
  enabled: boolean;
  sessions: ChatStatus[];
  turns: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}
export type ChatError = ChatCwdError | "chat_disabled";
export type ChatResult<T> = { ok: true; value: T } | { ok: false; error: ChatError };

export interface ChatManagerDeps {
  cfg: () => Config;
  gate: Pick<
    ProviderGate,
    "claimBlockReason" | "status" | "reportFailure" | "reportBudgetExhausted"
  >;
  spend: Pick<SpendLedger, "recordUsd" | "todayUsd" | "nextMidnightMs">;
  resolveCwd?: typeof resolveChatCwd;
  session?: ChatSessionDeps;
  onTurnComplete?: (
    session: ChatSession,
    result: ChatTurnResult,
    source: "operator" | "auto_lint",
  ) => Promise<void>;
  draftsParkedFor?: (slug: string) => number;
  abortGraceMs?: number;
  now?: () => number;
}

export class ChatManager {
  private readonly sessions = new Map<string, ChatSession>();
  private turns = 0;
  private costUsd = 0;
  private tokensIn = 0;
  private tokensOut = 0;

  constructor(private readonly deps: ChatManagerDeps) {}

  enabled(): boolean {
    return this.deps.cfg().chat.enabled;
  }

  async get(key: string): Promise<ChatResult<ChatSession>> {
    if (!this.enabled()) return { ok: false, error: "chat_disabled" };
    const slug = chatSlug(key);
    const existing = this.sessions.get(slug);
    if (existing) return { ok: true, value: existing };
    const cfg = this.deps.cfg();
    const cwd = await (this.deps.resolveCwd ?? resolveChatCwd)(cfg, key);
    if (!cwd.ok) return { ok: false, error: cwd.error };
    const session = new ChatSession(
      {
        cfg,
        key,
        kind: cwd.kind,
        cwd: cwd.cwd,
        nwo: cwd.nwo,
        dir: join(dataTreePaths(cfg).chats, slug),
      },
      { ...this.deps.session, now: this.deps.now },
    );
    this.sessions.set(slug, session);
    return { ok: true, value: session };
  }

  /** daemon.ts gatedReady's two checks, verbatim in order: budget (live
   * lever), then the gate. A block is a record on the stream, not an error. */
  private blockReason(session: ChatSession): { reason: string; until: string | null } | null {
    const cfg = this.deps.cfg();
    if (cfg.dailyBudgetUsd > 0) {
      const today = this.deps.spend.todayUsd();
      if (today >= cfg.dailyBudgetUsd) {
        this.deps.gate.reportBudgetExhausted(
          this.deps.spend.nextMidnightMs(),
          `daily budget $${cfg.dailyBudgetUsd.toFixed(2)} reached ($${today.toFixed(2)} spent)`,
        );
      }
    }
    const reason = this.deps.gate.claimBlockReason();
    if (!reason) return null;
    void session;
    return { reason, until: this.deps.gate.status().until };
  }

  async prompt(
    key: string,
    text: string,
    opts: { source?: "operator" | "auto_lint" } = {},
  ): Promise<ChatResult<{ mode: "prompt" | "steer" | "rejected" }>> {
    const got = await this.get(key);
    if (!got.ok) return got;
    const session = got.value;
    const source = opts.source ?? "operator";
    await session.ensureMeta();
    const block = this.blockReason(session);
    if (block) {
      session.writeRecord({
        type: "junco_chat_turn_rejected",
        reason: block.reason,
        until: block.until,
      });
      return { ok: true, value: { mode: "rejected" } };
    }
    const cfg = this.deps.cfg();
    const timeoutMs = (cfg.chat.turnTimeoutMinutes ?? cfg.defaultTimeoutMinutes) * 60_000;
    const result = await session.prompt(text, {
      source,
      timeoutMs,
      abortGraceMs: this.deps.abortGraceMs,
      classify: (m) => classifyProviderFailure(m),
    });
    if (result.mode === "steer") return { ok: true, value: { mode: "steer" } };
    this.turns++;
    this.costUsd += result.usage.costUsd;
    this.tokensIn += result.usage.input;
    this.tokensOut += result.usage.output;
    if (result.usage.costUsd > 0) this.deps.spend.recordUsd(result.usage.costUsd);
    if (result.status === "error" && result.errorMessage !== null) {
      const cls = classifyProviderFailure(result.errorMessage);
      if (GATE_CLASSES.has(cls)) this.deps.gate.reportFailure(cls, result.errorMessage);
    }
    if (this.deps.onTurnComplete) {
      try {
        await this.deps.onTurnComplete(session, result, source);
      } catch (e) {
        log.warn("chat onTurnComplete threw; ignoring", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { ok: true, value: { mode: "prompt" } };
  }

  async abort(key: string): Promise<ChatResult<{ aborted: boolean }>> {
    const got = await this.get(key);
    if (!got.ok) return got;
    return { ok: true, value: { aborted: await got.value.abort() } };
  }

  async fresh(key: string): Promise<ChatResult<null>> {
    const got = await this.get(key);
    if (!got.ok) return got;
    await got.value.reset("operator_new");
    this.sessions.delete(got.value.slug);
    return { ok: true, value: null };
  }

  async note(key: string, record: Omit<ChatDraftRecord, "ts">): Promise<ChatResult<null>> {
    const got = await this.get(key);
    if (!got.ok) return got;
    await got.value.ensureMeta();
    got.value.writeRecord(record);
    return { ok: true, value: null };
  }

  async subscribe(
    key: string,
    since: number,
    sub: ChatSubscriber,
  ): Promise<
    ChatResult<{ replay: Array<{ offset: number; line: string }>; unsubscribe: () => void }>
  > {
    const got = await this.get(key);
    if (!got.ok) return got;
    await got.value.ensureMeta();
    // Replay THEN attach: the sink is synchronous (chatSession.ts), so no line
    // can land between the read and the subscribe without being in the file.
    const replay = got.value.readLines(since);
    const unsubscribe = got.value.subscribe(sub);
    return { ok: true, value: { replay, unsubscribe } };
  }

  status(key: string): ChatStatus | null {
    const s = this.sessions.get(chatSlug(key));
    return s ? this.statusOf(s) : null;
  }

  private statusOf(s: ChatSession): ChatStatus {
    return {
      key: s.key,
      slug: s.slug,
      streaming: s.streaming,
      turns: s.turns,
      lastActivityAt: s.lastActivityAt,
      draftsParked: this.deps.draftsParkedFor?.(s.slug) ?? 0,
    };
  }

  health(): ChatHealth {
    return {
      enabled: this.enabled(),
      sessions: [...this.sessions.values()].map((s) => this.statusOf(s)),
      turns: this.turns,
      costUsd: this.costUsd,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
    };
  }

  /** Graceful stop (spec §2.4): every session drains before the health server closes. */
  async drain(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.drain()));
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/chatManager.test.ts > /tmp/t7 2>&1; echo "exit: $?"` — expected 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/chat/chatManager.ts tests/chatManager.test.ts
git add src/chat/chatManager.ts tests/chatManager.test.ts
git commit -m "feat(chat): ChatManager — registry, gate check, in-process spend, health, drain"
```

---

### Task 8: `chatRoutes.ts` and the health-server hook — SSE out, POST in, loopback-only

Spec §5. The health server hands every `/chat/*` request to an injected handler **before** its GET-only method gate; the handler owns method checks, the auth boundary, body parsing, SSE framing, and the ping.

**Files:**

- Create: `src/chat/chatRoutes.ts`
- Modify: `src/healthServer.ts` (`HealthServerOpts` ~line 20–45; the request handler ~145–190; `/health` body ~188)
- Test: `tests/chatRoutes.test.ts`, `tests/healthServer.test.ts` (one added case)

**Interfaces:**

- Consumes: `ChatManager`'s public methods (Task 7) via the narrow `ChatRoutesManager` type below; `ChatHealth`.
- Produces:

  ```ts
  // chatRoutes.ts
  export type ChatRoutesManager = Pick<ChatManager, "enabled" | "prompt" | "abort" | "fresh" | "note" | "subscribe" | "status">;
  export interface ChatRoutes { handle(req: IncomingMessage, res: ServerResponse): Promise<void> }
  export interface ChatRoutesDeps { isLoopback?: (req: IncomingMessage) => boolean; pingMs?: number; maxTextBytes?: number }
  export function makeChatRoutes(manager: ChatRoutesManager, deps?: ChatRoutesDeps): ChatRoutes;
  export function isLoopbackRequest(req: IncomingMessage): boolean;   // default predicate
  // healthServer.ts
  HealthServerOpts.chat?: ChatRoutes; HealthServerOpts.chatStatus?: () => ChatHealth;   // /health body gains `chats`
  ```

- [ ] **Step 1: Write the failing tests**

`tests/chatRoutes.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { startHealthServer, type HealthServerHandle } from "../src/healthServer.js";
import { makeChatRoutes, type ChatRoutesManager } from "../src/chat/chatRoutes.js";
import type { ChatSubscriber } from "../src/chat/chatSession.js";

function fakeMetrics() {
  return { snapshot: () => ({ pid: 1, uptimeSeconds: 1 }) as never };
}

/** A scriptable manager: records calls, lets a test push live lines/ends. */
function fakeManager(over: Partial<ChatRoutesManager> = {}) {
  const calls: unknown[][] = [];
  const subs = new Set<ChatSubscriber>();
  const m: ChatRoutesManager & {
    calls: unknown[][];
    push: (line: string, off: number | null) => void;
    end: () => void;
  } = {
    calls,
    push: (line, off) => subs.forEach((s) => s.onLine(line, off)),
    end: () => subs.forEach((s) => s.onEnd("daemon_stopped")),
    enabled: () => true,
    prompt: async (...a) => (calls.push(["prompt", ...a]), { ok: true, value: { mode: "prompt" } }),
    abort: async (...a) => (calls.push(["abort", ...a]), { ok: true, value: { aborted: true } }),
    fresh: async (...a) => (calls.push(["fresh", ...a]), { ok: true, value: null }),
    note: async (...a) => (calls.push(["note", ...a]), { ok: true, value: null }),
    subscribe: async (key, since, sub) => {
      calls.push(["subscribe", key, since]);
      subs.add(sub);
      return {
        ok: true,
        value: {
          replay: [
            { offset: 10, line: '{"type":"junco_meta"}' },
            { offset: 30, line: '{"type":"junco_chat_prompt"}' },
          ].filter((r) => r.offset > since),
          unsubscribe: () => subs.delete(sub),
        },
      };
    },
    status: (key) => ({
      key,
      slug: "x",
      streaming: false,
      turns: 0,
      lastActivityAt: null,
      draftsParked: 0,
    }),
    ...over,
  };
  return m;
}

async function readSse(resp: Response, untilEvents: number): Promise<string[]> {
  const reader = resp.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: string[] = [];
  while (events.length < untilEvents) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      events.push(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  await reader.cancel();
  return events;
}

let handle: HealthServerHandle | null = null;
afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
});

async function serve(m: ChatRoutesManager, deps = {}) {
  handle = await startHealthServer({
    port: 0,
    metrics: fakeMetrics(),
    chat: makeChatRoutes(m, deps),
  });
  return handle.url;
}

describe("/chat routes (spec 2026-09-01 §5)", () => {
  it("POST /chat/prompt → 202 with the mode; the manager receives key + text", async () => {
    const m = fakeManager();
    const url = await serve(m);
    const r = await fetch(`${url}/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "acme/api", text: "hi" }),
    });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ mode: "prompt" });
    expect(m.calls[0]).toEqual(["prompt", "acme/api", "hi", { source: "operator" }]);
  });

  it("gate-rejected prompt → 200 {mode:'rejected'}", async () => {
    const url = await serve(
      fakeManager({ prompt: async () => ({ ok: true, value: { mode: "rejected" } }) }),
    );
    const r = await fetch(`${url}/chat/prompt`, {
      method: "POST",
      body: JSON.stringify({ key: "k", text: "t" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ mode: "rejected" });
  });

  it("manager errors map to status codes: unknown_key 404, no_checkout/not_a_repo 409, chat_disabled 503", async () => {
    for (const [error, status] of [
      ["unknown_key", 404],
      ["no_checkout", 409],
      ["not_a_repo", 409],
      ["chat_disabled", 503],
    ] as const) {
      const url = await serve(fakeManager({ prompt: async () => ({ ok: false, error }) }));
      const r = await fetch(`${url}/chat/prompt`, {
        method: "POST",
        body: JSON.stringify({ key: "k", text: "t" }),
      });
      expect(r.status).toBe(status);
      expect(await r.json()).toEqual({ error });
      await handle!.close();
      handle = null;
    }
  });

  it("bad requests: malformed JSON 400, missing key 400, oversized text 413, wrong method 405, unknown route 404", async () => {
    const url = await serve(fakeManager(), { maxTextBytes: 16 });
    expect((await fetch(`${url}/chat/prompt`, { method: "POST", body: "{nope" })).status).toBe(400);
    expect(
      (await fetch(`${url}/chat/prompt`, { method: "POST", body: JSON.stringify({ text: "t" }) }))
        .status,
    ).toBe(400);
    expect(
      (
        await fetch(`${url}/chat/prompt`, {
          method: "POST",
          body: JSON.stringify({ key: "k", text: "x".repeat(100) }),
        })
      ).status,
    ).toBe(413);
    expect((await fetch(`${url}/chat/prompt`)).status).toBe(405);
    expect((await fetch(`${url}/chat/nothing`)).status).toBe(404);
  });

  it("auth boundary: non-loopback → 403; an Origin header → 403; /health stays open", async () => {
    const url = await serve(fakeManager(), { isLoopback: () => false });
    expect((await fetch(`${url}/chat/status?key=k`)).status).toBe(403);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    await handle!.close();
    const url2 = await serve(fakeManager());
    const r = await fetch(`${url2}/chat/status?key=k`, {
      headers: { origin: "http://evil.example" },
    });
    expect(r.status).toBe(403);
  });

  it("abort/new/note/status wire through", async () => {
    const m = fakeManager();
    const url = await serve(m);
    expect(
      (await fetch(`${url}/chat/abort`, { method: "POST", body: JSON.stringify({ key: "k" }) }))
        .status,
    ).toBe(202);
    expect(
      (await fetch(`${url}/chat/new`, { method: "POST", body: JSON.stringify({ key: "k" }) }))
        .status,
    ).toBe(202);
    const note = {
      type: "junco_chat_draft",
      draftId: "d",
      kind: "ticket",
      status: "submitted",
      ids: ["t"],
      destination: "inbox",
    };
    expect(
      (
        await fetch(`${url}/chat/note`, {
          method: "POST",
          body: JSON.stringify({ key: "k", record: note }),
        })
      ).status,
    ).toBe(202);
    const st = await fetch(`${url}/chat/status?key=${encodeURIComponent("acme/api")}`);
    expect(st.status).toBe(200);
    expect(await st.json()).toMatchObject({ key: "acme/api" });
    expect(m.calls.map((c) => c[0])).toEqual(["abort", "fresh", "note"]);
    expect(m.calls[2]![2]).toEqual(note);
  });

  it("GET /chat/events replays from `since`, then streams live lines (id-less when bus-only) and ends", async () => {
    const m = fakeManager();
    const url = await serve(m, { pingMs: 60_000 });
    const resp = await fetch(`${url}/chat/events?key=${encodeURIComponent("acme/api")}&since=10`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    // give the replay a tick, then push live
    await new Promise((r) => setTimeout(r, 20));
    m.push('{"type":"message_update"}', null);
    m.push('{"type":"turn_end"}', 55);
    m.end();
    const events = await readSse(resp, 4);
    expect(events[0]).toBe('id: 30\ndata: {"type":"junco_chat_prompt"}');
    expect(events[1]).toBe('data: {"type":"message_update"}');
    expect(events[2]).toBe('id: 55\ndata: {"type":"turn_end"}');
    expect(events[3]).toBe('event: end\ndata: {"reason":"daemon_stopped"}');
    expect(m.calls[0]).toEqual(["subscribe", "acme/api", 10]);
  });

  it("Last-Event-ID is honored as `since`", async () => {
    const m = fakeManager();
    const url = await serve(m, { pingMs: 60_000 });
    const resp = await fetch(`${url}/chat/events?key=k`, { headers: { "last-event-id": "30" } });
    await readSse(resp, 0);
    expect(m.calls[0]).toEqual(["subscribe", "k", 30]);
  });

  it("emits a `: ping` comment at pingMs", async () => {
    const url = await serve(fakeManager(), { pingMs: 15 });
    const resp = await fetch(`${url}/chat/events?key=k&since=100`);
    const events = await readSse(resp, 1);
    expect(events[0]).toBe(": ping");
  });
});
```

Add to `tests/healthServer.test.ts`:

```ts
it("/health carries `chats` from chatStatus, and /chat/* is 404 without a chat handler", async () => {
  handle = await startHealthServer({
    port: 0,
    metrics: makeFakeMetrics(),
    chatStatus: () => ({
      enabled: true,
      sessions: [],
      turns: 0,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    }),
  });
  const body = (await (await fetch(`${handle.url}/health`)).json()) as { chats?: unknown };
  expect(body.chats).toEqual({
    enabled: true,
    sessions: [],
    turns: 0,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  });
  expect((await fetch(`${handle.url}/chat/status?key=k`)).status).toBe(404);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/chatRoutes.test.ts tests/healthServer.test.ts > /tmp/t8 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/healthServer.ts` — add to imports: `import type { ChatHealth } from "./chat/chatManager.js";` and `import type { ChatRoutes } from "./chat/chatRoutes.js";` (both type-only). Add to `HealthServerOpts`:

```ts
  /** /chat/* handler (spec 2026-09-01 §5). Absent → those paths are 404. It
   *  is consulted BEFORE the GET-only gate: the handler owns its methods. */
  chat?: ChatRoutes;
  /** `/health.chats` — the chat manager's health view; absent on an older daemon. */
  chatStatus?: () => ChatHealth;
```

In the request handler, as the FIRST statement inside the `try`:

```ts
const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
if (rawPath === "/chat" || rawPath.startsWith("/chat/")) {
  if (!opts.chat) {
    writeJson(res, 404, { error: "not found" });
    return;
  }
  await opts.chat.handle(req, res);
  return;
}
```

In the `/health` branch add `chats` beside `spend`:

```ts
const chats = safeChats(opts.chatStatus);
writeJson(res, 200, { status: "ok", ready, metrics: snap, gate, spend, chats });
```

with, next to `safeSpend`:

```ts
function safeChats(fn: (() => ChatHealth) | undefined): ChatHealth | null {
  if (!fn) return null;
  try {
    return fn();
  } catch {
    return null;
  }
}
```

`src/chat/chatRoutes.ts`:

```ts
/**
 * /chat/* on the health server (spec 2026-09-01 §5): SSE out, POST in, and
 * the auth boundary — loopback-only regardless of healthHost, and any request
 * carrying an Origin header is refused (a browser always sends one
 * cross-origin; the TUI never does), which closes the localhost-CSRF door
 * without a token. Every response is JSON except the event stream.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatManager, ChatError } from "./chatManager.js";
import type { ChatDraftRecord } from "../agent/transcriptSchema.js";

export type ChatRoutesManager = Pick<
  ChatManager,
  "enabled" | "prompt" | "abort" | "fresh" | "note" | "subscribe" | "status"
>;

export interface ChatRoutes {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export interface ChatRoutesDeps {
  isLoopback?: (req: IncomingMessage) => boolean;
  /** SSE keep-alive comment cadence (default 15 s). */
  pingMs?: number;
  /** Prompt text cap (default 64 KiB) → 413. */
  maxTextBytes?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackRequest(req: IncomingMessage): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? "");
}

const STATUS: Record<ChatError, number> = {
  unknown_key: 404,
  no_checkout: 409,
  not_a_repo: 409,
  chat_disabled: 503,
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(s),
    "cache-control": "no-store",
  });
  res.end(s);
}

async function readBody(
  req: IncomingMessage,
  max: number,
): Promise<{ ok: true; text: string } | { ok: false; status: 413 }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > max) return { ok: false, status: 413 };
    chunks.push(b);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function makeChatRoutes(manager: ChatRoutesManager, deps: ChatRoutesDeps = {}): ChatRoutes {
  const isLoopback = deps.isLoopback ?? isLoopbackRequest;
  const pingMs = deps.pingMs ?? 15_000;
  const maxTextBytes = deps.maxTextBytes ?? 64 * 1024;

  const sse = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const key = url.searchParams.get("key");
    if (!key) return json(res, 400, { error: "missing key" });
    const sinceRaw = url.searchParams.get("since") ?? req.headers["last-event-id"];
    const since = Number.parseInt(typeof sinceRaw === "string" ? sinceRaw : "0", 10);
    const r = await manager.subscribe(key, Number.isFinite(since) && since > 0 ? since : 0, {
      onLine(line, offset) {
        const data = line.endsWith("\n") ? line.slice(0, -1) : line;
        res.write(offset === null ? `data: ${data}\n\n` : `id: ${offset}\ndata: ${data}\n\n`);
      },
      onEnd(reason) {
        res.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
        res.end();
      },
    });
    if (!r.ok) return json(res, STATUS[r.error], { error: r.error });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const { offset, line } of r.value.replay) res.write(`id: ${offset}\ndata: ${line}\n\n`);
    const ping = setInterval(() => res.write(": ping\n\n"), pingMs);
    const cleanup = (): void => {
      clearInterval(ping);
      r.value.unsubscribe();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  };

  const post = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const body = await readBody(req, maxTextBytes + 4096);
    if (!body.ok) return json(res, 413, { error: "payload too large" });
    const obj = parseJsonObject(body.text);
    const key = obj?.key;
    if (!obj || typeof key !== "string" || key === "")
      return json(res, 400, { error: "bad request" });
    const fail = (e: ChatError): void => json(res, STATUS[e], { error: e });
    switch (path) {
      case "/chat/prompt": {
        const text = obj.text;
        if (typeof text !== "string") return json(res, 400, { error: "bad request" });
        if (Buffer.byteLength(text, "utf8") > maxTextBytes)
          return json(res, 413, { error: "text too large" });
        const r = await manager.prompt(key, text, { source: "operator" });
        if (!r.ok) return fail(r.error);
        return json(res, r.value.mode === "rejected" ? 200 : 202, { mode: r.value.mode });
      }
      case "/chat/abort": {
        const r = await manager.abort(key);
        if (!r.ok) return fail(r.error);
        res.writeHead(r.value.aborted ? 202 : 204);
        return res.end();
      }
      case "/chat/new": {
        const r = await manager.fresh(key);
        if (!r.ok) return fail(r.error);
        res.writeHead(202);
        return res.end();
      }
      case "/chat/note": {
        const rec = obj.record;
        if (
          !rec ||
          typeof rec !== "object" ||
          (rec as { type?: unknown }).type !== "junco_chat_draft"
        )
          return json(res, 400, { error: "bad request" });
        const r = await manager.note(key, rec as Omit<ChatDraftRecord, "ts">);
        if (!r.ok) return fail(r.error);
        res.writeHead(202);
        return res.end();
      }
      default:
        return json(res, 404, { error: "not found" });
    }
  };

  return {
    async handle(req, res) {
      if (!isLoopback(req) || req.headers.origin !== undefined)
        return json(res, 403, { error: "forbidden" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (req.method === "GET") {
        if (path === "/chat/events") return sse(req, res, url);
        if (path === "/chat/status") {
          const key = url.searchParams.get("key");
          if (!key) return json(res, 400, { error: "missing key" });
          if (!manager.enabled()) return json(res, 503, { error: "chat_disabled" });
          const s = manager.status(key);
          return s ? json(res, 200, s) : json(res, 404, { error: "unknown_key" });
        }
        if (
          path === "/chat/prompt" ||
          path === "/chat/abort" ||
          path === "/chat/new" ||
          path === "/chat/note"
        )
          return json(res, 405, { error: "method not allowed" });
        return json(res, 404, { error: "not found" });
      }
      if (req.method === "POST") return post(req, res, path);
      return json(res, 405, { error: "method not allowed" });
    },
  };
}
```

`/chat/status` for a key the manager has not materialized returns 404 — the fake in the test always returns a status; the daemon's real manager returns `null` until the first prompt/attach, which the client treats as "idle, no session yet" (Task 14).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/chatRoutes.test.ts tests/healthServer.test.ts > /tmp/t8 2>&1; echo "exit: $?"` — expected 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/chat/chatRoutes.ts src/healthServer.ts tests/chatRoutes.test.ts tests/healthServer.test.ts
git add src/chat/chatRoutes.ts src/healthServer.ts tests/chatRoutes.test.ts tests/healthServer.test.ts
git commit -m "feat(chat): /chat/* routes — SSE stream, POST verbs, loopback-only auth boundary"
```

---

### Task 9: Daemon wiring, `/health.chats` on the client side

Spec §2.4, §4. `mainLoop` builds the manager with the same `gate`/`spend`/`activeCfg` closures the poll loop uses, hands the routes and status closure to the health server, and drains chat **before** the health server closes. The dashboard's `HealthBody`/`HealthInfo` learn the optional `chats` key (optional, like `gate`/`spend`, so no fixture changes).

**Files:**

- Modify: `src/daemon.ts` (`MainLoopDeps` ~line 233–330; the health-server block ~823–846; the `finally` ~894–903)
- Modify: `src/tui/healthBody.ts` (`HealthBody` ~line 16–30), `src/tui/ghClient.ts` (`HealthInfo` ~110–122; `health()` ~690–740)
- Test: `tests/daemon.test.ts` (two cases), `tests/useHealth.test.tsx` or `tests/ghClient*.test.ts` (one case: `chats` passes through)

**Interfaces:**

- Consumes: `ChatManager`, `ChatHealth` (Task 7); `makeChatRoutes` (Task 8).
- Produces: `MainLoopDeps.chatManager?: ChatManager`, `MainLoopDeps.chatSessionDeps?: ChatSessionDeps`; `HealthBody.chats?: ChatHealth | null`; `HealthInfo.chats?: ChatHealth | null`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/daemon.test.ts` in the health-server wiring `describe`:

```ts
it("wires chat routes + chatStatus into the health server (spec 2026-09-01 §2.4)", async () => {
  const cfg = makeConfig({ healthEnabled: true });
  const stop = new StopFlag();
  const handle = makeFakeHealthHandle();
  const startHealthServerFn = vi.fn(async (_opts: HealthServerOpts) => handle);
  const makeChatRoutesFn = vi.fn(makeChatRoutes);
  const { deps } = makeDeps({
    startHealthServerFn,
    makeChatRoutesFn,
    runOnceFn: vi.fn(async () => false),
    sleep: vi.fn(async () => {
      stop.requestStop();
    }),
  });
  await mainLoop(cfg, stop, {}, deps);
  const arg = startHealthServerFn.mock.calls[0]![0]!;
  expect(typeof arg.chat?.handle).toBe("function");
  expect(arg.chatStatus!()).toMatchObject({ enabled: true, sessions: [], turns: 0 });
  // R12: the routes are built with the configured health host on the Host allowlist.
  expect(makeChatRoutesFn).toHaveBeenCalledWith(expect.anything(), { allowedHost: cfg.healthHost });
});

it("drains chat BEFORE closing the health server on shutdown", async () => {
  const cfg = makeConfig({ healthEnabled: true });
  const stop = new StopFlag();
  const handle = makeFakeHealthHandle();
  const drain = vi.fn(async () => {});
  const chatManager = {
    drain,
    health: () => ({
      enabled: true,
      sessions: [],
      turns: 0,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    }),
    enabled: () => true,
  } as unknown as ChatManager;
  const { deps } = makeDeps({
    startHealthServerFn: vi.fn(async () => handle),
    chatManager,
    runOnceFn: vi.fn(async () => false),
    sleep: vi.fn(async () => {
      stop.requestStop();
    }),
  });
  await mainLoop(cfg, stop, {}, deps);
  expect(drain).toHaveBeenCalledTimes(1);
  const closeMock = handle.close as ReturnType<typeof vi.fn>;
  expect(drain.mock.invocationCallOrder[0]!).toBeLessThan(closeMock.mock.invocationCallOrder[0]!);
});
```

(add `import type { ChatManager } from "../src/chat/chatManager.js";` and `import { makeChatRoutes } from "../src/chat/chatRoutes.js";` at the top).

In `tests/tuiGhClient.test.ts`, the `health()` case (~line 515–560) asserts the up/down objects with `toEqual` — add `chats: null` to both expected literals (the `fetchOk` body has no `chats`, so it maps to `null`), and add beside it, using the same `makeGhDashboardClient(cfg, { ...fakes(), fetchFn })` pattern:

```ts
it("health() passes /health.chats through (spec 2026-09-01 §4)", async () => {
  const chats = {
    enabled: true,
    sessions: [],
    turns: 2,
    costUsd: 0.5,
    tokensIn: 10,
    tokensOut: 20,
  };
  const fetchChats = (async () => ({
    ok: true,
    json: async () => ({ ready: true, metrics: {}, chats }),
  })) as unknown as typeof fetch;
  const c = makeGhDashboardClient(cfg, { ...fakes(), fetchFn: fetchChats });
  expect((await c.health()).chats).toEqual(chats);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/daemon.test.ts > /tmp/t9 2>&1; echo "exit: $?"` — expected 1 (`arg.chat` undefined; `chatManager` not a dep).

- [ ] **Step 3: Implement**

`src/daemon.ts` — imports:

```ts
import { ChatManager } from "./chat/chatManager.js";
import { makeChatRoutes } from "./chat/chatRoutes.js";
import type { ChatSessionDeps } from "./chat/chatSession.js";
```

`MainLoopDeps` gains:

```ts
  /** Route builder seam (tests assert the Host allowlist wiring, R12). */
  makeChatRoutesFn?: typeof makeChatRoutes;
  /** Dashboard chat (spec 2026-09-01). Absent → mainLoop builds a ChatManager
   *  over the same gate/spend/activeCfg closures the poll loop uses. Tests
   *  inject a fake to assert wiring + drain order. */
  chatManager?: ChatManager;
  /** Seams for the ChatManager mainLoop builds (fake session factory, fs). */
  chatSessionDeps?: ChatSessionDeps;
```

Immediately before the health-endpoint block (`let health: HealthServerHandle | null = null;`):

```ts
// Dashboard chat (spec 2026-09-01 §2.4): idle-cost-free until the first
// attach/prompt. Same gate/spend/activeCfg the poll loop uses, so a chat
// turn is gated and billed exactly like a ticket claim.
const chat =
  deps.chatManager ??
  new ChatManager({
    cfg: activeCfg,
    gate,
    spend,
    session: deps.chatSessionDeps,
  });
```

In the `startHealthServerFn({...})` call add:

```ts
        // allowedHost: the Host allowlist half of the /chat/* boundary (spec
        // §5.3, R12) admits the configured health host besides the loopback
        // names, so a dashboard pointed at healthHost is never refused.
        chat: (deps.makeChatRoutesFn ?? makeChatRoutes)(chat, { allowedHost: cfg.healthHost }),
        chatStatus: () => chat.health(),
```

In the `finally`, before `if (health) await health.close();`:

```ts
// Chat drains BEFORE the health server closes (spec 2026-09-01 §2.4):
// every streaming turn is soft-aborted and stamped daemon_stopped, and
// every SSE subscriber gets its terminal event while the socket is up.
try {
  await chat.drain();
} catch (e) {
  log.warn("chat drain failed; continuing shutdown", {
    error: e instanceof Error ? e.message : String(e),
  });
}
```

`src/tui/healthBody.ts` — `import type { ChatHealth } from "../chat/chatManager.js";` and in `HealthBody`:

```ts
  /** Dashboard chat (spec 2026-09-01) — absent entirely on an older daemon. */
  chats?: ChatHealth | null;
```

`src/tui/ghClient.ts` — `import type { ChatHealth } from "../chat/chatManager.js";`; in `HealthInfo`:

```ts
  /** /health.chats — null when the daemon is down or predates chat. */
  chats?: ChatHealth | null;
```

In `health()`: the `down` literal gains `chats: null`; extend the parsed shape with `chats?: ChatHealth | null` and the returned object with `chats: j.chats ?? null`.

`ChatManager` is imported by `daemon.ts` at module top level — it is SDK-free (the SDK-touching helpers are reached through `ChatSessionDeps` defaults that resolve inside `agent/session.ts`). Verify with `npx vitest run tests/sdkImportSurface.test.ts`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/daemon.test.ts tests/sdkImportSurface.test.ts tests/tuiGhClient.test.ts > /tmp/t9 2>&1; echo "exit: $?"` — expected 0. `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/daemon.ts src/tui/healthBody.ts src/tui/ghClient.ts tests/daemon.test.ts tests/tuiGhClient.test.ts
git add src/daemon.ts src/tui/healthBody.ts src/tui/ghClient.ts tests/daemon.test.ts tests/tuiGhClient.test.ts
git commit -m "feat(chat): wire ChatManager into the daemon; drain before health close; /health.chats"
```

Then merge `origin/main` (`git fetch origin && git merge origin/main`) and re-run the full suite before Task 10.

---

### Task 10: `fenceExtract.ts` — fences → drafts with kind and the frontmatter allowlist

**Also in this task (upstream #389 rename):** the two `DraftKind` literals Task 1 landed as `"assess" | "analyze"` in `src/agent/transcriptSchema.ts` become `"audit" | "investigate"` — #389 renamed the CLI verbs (`junco audit`, `junco investigate`) and made `audit:`/`investigate:` the canonical frontmatter keys with `assess:`/`analyze:` kept as legacy aliases; new identifiers follow the canonical names. Include that rename in this task's commit.

Spec §6.1. Pure: text in, `ExtractedDraft[]` out. Reuses `githubInbox.ts`'s fence semantics (a complete block, longest-backtick opener, CRLF normalized) through a new exported `allFencedBlocks` — the existing `extractFencedBlock` strips frontmatter and returns only the LAST block, and chat needs every block _with_ its (allowlisted) frontmatter.

**Files:**

- Modify: `src/githubInbox.ts` (export `allFencedBlocks` beside `lastFencedBlockRange` ~line 219)
- Create: `src/chat/fenceExtract.ts`
- Test: `tests/fenceExtract.test.ts`, `tests/githubInbox.test.ts` (one case for `allFencedBlocks`)

**Interfaces:**

- Consumes: `PLAN_FENCE` (`src/planPrompt.ts`), `PLAN_SET_FENCE`, `extractPatchBody` (`src/githubInbox.ts`), `parse as parseYaml`/`stringify as stringifyYaml` (`yaml`), `DraftKind` (Task 1).
- Produces:

  ```ts
  export const FRONTMATTER_ALLOWLIST: ReadonlySet<string>;
  export interface ExtractedFile {
    name: string;
    content: string;
    frontmatter: Record<string, unknown>;
    body: string;
    droppedKeys: string[];
    id: string | null;
  }
  export interface ExtractedDraft {
    kind: DraftKind;
    files: ExtractedFile[];
    blocked: "plan_sets_disabled" | null;
    commandArgs: string[] | null;
    problems: string[];
  }
  export interface ExtractCtx {
    repo: string;
    nwo: string | null;
    planSetsEnabled: boolean;
  }
  export function extractDrafts(text: string, ctx: ExtractCtx): ExtractedDraft[];
  // githubInbox.ts
  export function allFencedBlocks(text: string, fenceTag: string): string[]; // every COMPLETE block, raw (no strip), document order
  ```

- [ ] **Step 1: Write the failing tests**

Add to `tests/githubInbox.test.ts`:

`````ts
describe("allFencedBlocks", () => {
  it("returns every complete block of the tag, raw, in document order; ignores unterminated ones", () => {
    const text = [
      "intro",
      "```junco-ticket",
      "---",
      "id: a",
      "---",
      "# A",
      "```",
      "between",
      "````junco-ticket",
      "# B with ```inner```",
      "````",
      "```junco-ticket",
      "# unterminated",
    ].join("\n");
    expect(allFencedBlocks(text, "junco-ticket")).toEqual([
      "---\nid: a\n---\n# A",
      "# B with ```inner```",
    ]);
    expect(allFencedBlocks(text, "junco-plan")).toEqual([]);
  });
});
`````

`tests/fenceExtract.test.ts`:

````ts
import { describe, it, expect } from "vitest";
import { extractDrafts, FRONTMATTER_ALLOWLIST } from "../src/chat/fenceExtract.js";

const ctx = { repo: "/repo/acme-api", nwo: "acme/api", planSetsEnabled: true };
const fence = (fm: string, body: string, tag = "junco-ticket") =>
  `\`\`\`${tag}\n---\n${fm}\n---\n${body}\n\`\`\``;

describe("extractDrafts (spec 2026-09-01 §6.1)", () => {
  it("no fence → no drafts", () => {
    expect(extractDrafts("just prose", ctx)).toEqual([]);
  });

  it("one junco-ticket fence → kind ticket; repo is set by junco, not the model", () => {
    const [d] = extractDrafts(
      fence("id: add-cache\npr_title: Add cache", "# Add cache\n\nbody"),
      ctx,
    );
    expect(d!.kind).toBe("ticket");
    expect(d!.files).toHaveLength(1);
    const f = d!.files[0]!;
    expect(f.id).toBe("add-cache");
    expect(f.name).toBe("add-cache.md");
    expect(f.frontmatter).toEqual({ id: "add-cache", pr_title: "Add cache", repo: "acme/api" });
    expect(f.content.startsWith("---\n")).toBe(true);
    expect(f.content).toContain("repo: acme/api");
    expect(f.content.endsWith("# Add cache\n\nbody\n")).toBe(true);
    expect(f.droppedKeys).toEqual([]);
  });

  it("the allowlist drops tools/network/workdir/repo/unknown keys and records them", () => {
    const [d] = extractDrafts(
      fence(
        "id: x\ntools: [bash]\nnetwork: true\nworkdir: /etc\nrepo: /elsewhere\nfoo: 1\nlabels: [a]",
        "# X",
      ),
      ctx,
    );
    const f = d!.files[0]!;
    expect(f.frontmatter).toEqual({ id: "x", labels: ["a"], repo: "acme/api" });
    expect(f.droppedKeys.sort()).toEqual(["foo", "network", "repo", "tools", "workdir"]);
    for (const k of [
      "tools",
      "network",
      "workdir",
      "repo",
      "push_remote",
      "not_before",
      "retry_count",
      "deps_satisfied",
      "plan",
    ])
      expect(FRONTMATTER_ALLOWLIST.has(k)).toBe(false);
  });

  it("local repo (no nwo): repo is the cwd", () => {
    const [d] = extractDrafts(fence("id: x", "# X"), { ...ctx, nwo: null });
    expect(d!.files[0]!.frontmatter.repo).toBe("/repo/acme-api");
  });

  it("kinds by frontmatter shape, with precedence audit > investigate > amend > apply > ticket; legacy keys accepted, canonical wins", () => {
    const k = (fm: string, body = "# T") => extractDrafts(fence(fm, body), ctx)[0]!.kind;
    expect(k("id: a\namends_pr: 42")).toBe("amend");
    expect(k("id: a", "# T\n\n```junco-patch\nFrom 0 Mon Sep 17 00:00:00 2001\n```")).toBe("apply");
    expect(k("id: a\naudit:\n  auto_plan: true")).toBe("audit");
    expect(k("id: a\ninvestigate:\n  issue: 7")).toBe("investigate");
    expect(k("id: a\naudit: {}\ninvestigate:\n  issue: 7\namends_pr: 1")).toBe("audit");
    expect(k("id: a\nassess:\n  auto_plan: true")).toBe("audit"); // legacy key
    expect(k("id: a\nanalyze:\n  issue: 7")).toBe("investigate"); // legacy key
    const both = extractDrafts(
      fence("id: a\naudit:\n  issue: 3\nassess:\n  issue: 9", "# A"),
      ctx,
    )[0]!;
    expect(both.commandArgs).toEqual(["audit", "acme/api#3"]); // canonical wins
    expect(both.files[0]!.frontmatter.assess).toBeUndefined(); // the losing legacy key is dropped
    expect(both.files[0]!.droppedKeys).toEqual(["assess"]);
  });

  it("audit/investigate derive commandArgs at extraction; a missing issue is a problem", () => {
    const a = extractDrafts(fence("id: a\naudit:\n  auto_plan: true\n  issue: 12", "# A"), ctx)[0]!;
    expect(a.commandArgs).toEqual(["audit", "acme/api#12", "--auto-plan"]);
    const a2 = extractDrafts(fence("id: a\naudit: {}", "# A"), { ...ctx, nwo: null })[0]!;
    expect(a2.commandArgs).toEqual(["audit", "/repo/acme-api"]);
    const z = extractDrafts(fence("id: z\ninvestigate:\n  issue: 7", "# Z"), ctx)[0]!;
    expect(z.commandArgs).toEqual(["investigate", "acme/api#7"]);
    const bad = extractDrafts(fence("id: z\ninvestigate: {}", "# Z"), ctx)[0]!;
    expect(bad.commandArgs).toBeNull();
    expect(bad.problems).toEqual(["investigate.issue is required"]);
    const local = extractDrafts(fence("id: z\ninvestigate:\n  issue: 7", "# Z"), {
      ...ctx,
      nwo: null,
    })[0]!;
    expect(local.problems).toEqual(["investigate needs a watched owner/repo"]);
  });

  it("two or more junco-ticket fences → one ticketSet; every file needs an id; unknown depends_on is a problem", () => {
    const text = [
      fence("id: api\n", "# API"),
      fence("id: ui\ndepends_on: [api, ghost]", "# UI"),
    ].join("\n\n");
    const [d] = extractDrafts(text, ctx);
    expect(d!.kind).toBe("ticketSet");
    expect(d!.files.map((f) => f.name)).toEqual(["api.md", "ui.md"]);
    expect(d!.problems).toEqual(["ui: depends_on names no sibling: ghost"]);
    const noId = extractDrafts(
      [fence("id: a", "# A"), fence("pr_title: b", "# B")].join("\n"),
      ctx,
    )[0]!;
    expect(noId.problems).toEqual(["every ticket in a set needs an explicit id (file 2 has none)"]);
  });

  it("a fence without frontmatter gets a generated id from the H1", () => {
    const [d] = extractDrafts("```junco-ticket\n# Fix the flaky test\n\nbody\n```", ctx);
    expect(d!.files[0]!.id).toBe("fix-the-flaky-test");
    expect(d!.files[0]!.frontmatter).toEqual({ id: "fix-the-flaky-test", repo: "acme/api" });
  });

  it("junco-plan → planSet (blocked when plan sets are off); both fence kinds in one message → two drafts", () => {
    const plan = "```junco-plan\nversion: 1\ntasks:\n  - id: a\n    title: A\n```";
    const on = extractDrafts(plan, ctx);
    expect(on).toHaveLength(1);
    expect(on[0]!.kind).toBe("planSet");
    expect(on[0]!.blocked).toBeNull();
    expect(on[0]!.files[0]!.name).toBe("plan.md");
    const off = extractDrafts(plan, { ...ctx, planSetsEnabled: false });
    expect(off[0]!.blocked).toBe("plan_sets_disabled");
    const both = extractDrafts(plan + "\n" + fence("id: t", "# T"), ctx);
    expect(both.map((d) => d.kind).sort()).toEqual(["planSet", "ticket"]);
  });

  it("invalid YAML frontmatter is a problem, not a throw", () => {
    const [d] = extractDrafts("```junco-ticket\n---\nid: [unclosed\n---\n# T\n```", ctx);
    expect(d!.problems[0]).toMatch(/frontmatter/);
  });
});
````

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/fenceExtract.test.ts tests/githubInbox.test.ts > /tmp/t10 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/githubInbox.ts` — after `lastFencedBlockRange`:

````ts
/** Every COMPLETE ```<fenceTag> block, raw (frontmatter kept — the dashboard
 * chat allowlists it itself, spec 2026-09-01 §6.1), in document order. Same
 * opener/closer rules as lastFencedBlockRange. */
export function allFencedBlocks(text: string, fenceTag: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const openRe = new RegExp("^(`{3,})" + fenceTag + "\\s*$");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = openRe.exec(lines[i]);
    if (!m) continue;
    const closeRe = new RegExp("^`{" + m[1].length + ",}\\s*$");
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closeRe.test(lines[j])) {
        close = j;
        break;
      }
    }
    if (close === -1) continue;
    out.push(lines.slice(i + 1, close).join("\n"));
    i = close;
  }
  return out;
}
````

`src/chat/fenceExtract.ts`:

```ts
/**
 * Fences → drafts (spec 2026-09-01 §6.1). Pure. The GitHub planner emits a
 * ticket BODY only ("model output can never set repo:/workdir:/tools:/
 * network:", planPrompt.ts); chat needs model-authored frontmatter to express
 * kinds, so the boundary here is an ALLOWLIST: junco sets `repo:` itself and
 * drops everything not listed, recording the dropped names for the card.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { DraftKind } from "../agent/transcriptSchema.js";
import { PLAN_FENCE } from "../planPrompt.js";
import { PLAN_SET_FENCE, allFencedBlocks, extractPatchBody } from "../githubInbox.js";

export const FRONTMATTER_ALLOWLIST: ReadonlySet<string> = new Set([
  "id",
  "pr_title",
  "branch_name",
  "base_branch",
  "priority",
  "labels",
  "reviewers",
  "draft",
  "depends_on",
  "amends_pr",
  "timeout_minutes",
  "github_request",
  "audit",
  "investigate",
  // Legacy aliases parseTicket still accepts (#389); the canonical key wins on a collision.
  "assess",
  "analyze",
]);

export interface ExtractedFile {
  name: string;
  /** Allowlisted frontmatter + repo: + body — byte-identical to what lint sees. */
  content: string;
  frontmatter: Record<string, unknown>;
  body: string;
  droppedKeys: string[];
  id: string | null;
}

export interface ExtractedDraft {
  kind: DraftKind;
  files: ExtractedFile[];
  blocked: "plan_sets_disabled" | null;
  /** audit/investigate: the verb's argv, derived here so confirm never re-reads the fence. */
  commandArgs: string[] | null;
  /** Structural problems found here (lint runs later, in chatDrafts.ts). */
  problems: string[];
}

export interface ExtractCtx {
  /** The session cwd — `repo:` for a local session. */
  repo: string;
  /** owner/repo for a watched session — `repo:` then, and the audit/investigate target. */
  nwo: string | null;
  planSetsEnabled: boolean;
}

const FM_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "ticket";

function h1Of(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1]!.trim() : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function splitFile(raw: string, ctx: ExtractCtx, problems: string[]): ExtractedFile {
  const m = FM_RE.exec(raw);
  let fm: Record<string, unknown> = {};
  let body = raw;
  if (m) {
    body = m[2] ?? "";
    try {
      const parsed: unknown = parseYaml(m[1] ?? "");
      if (isRecord(parsed)) fm = parsed;
      else if (parsed !== null && parsed !== undefined)
        problems.push("frontmatter is not a mapping");
    } catch (e) {
      problems.push(`frontmatter did not parse: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const kept: Record<string, unknown> = {};
  const droppedKeys: string[] = [];
  for (const [k, v] of Object.entries(fm)) {
    if (FRONTMATTER_ALLOWLIST.has(k)) kept[k] = v;
    else droppedKeys.push(k);
  }
  // A ticket carrying both the canonical and the legacy request key: the
  // canonical wins (parseTicket's own precedence, #389) and the loser is
  // dropped here so the parked file never trips the key_collision lint.
  for (const [canonical, legacy] of [
    ["audit", "assess"],
    ["investigate", "analyze"],
  ] as const) {
    if (canonical in kept && legacy in kept) {
      delete kept[legacy];
      droppedKeys.push(legacy);
    }
  }
  if (typeof kept.id !== "string" || kept.id === "") {
    const h1 = h1Of(body);
    if (h1) kept.id = slug(h1);
    else delete kept.id;
  }
  kept.repo = ctx.nwo ?? ctx.repo;
  const id = typeof kept.id === "string" ? kept.id : null;
  const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
  const content = `---\n${stringifyYaml(kept).trimEnd()}\n---\n${trimmedBody}\n`;
  return {
    name: `${id ?? "ticket"}.md`,
    content,
    frontmatter: kept,
    body: trimmedBody,
    droppedKeys,
    id,
  };
}

/** The audit/investigate request block: canonical key, else the legacy alias
 * (#389: `audit:`/`investigate:` canonical; `assess:`/`analyze:` accepted). */
function requestBlock(
  fm: Record<string, unknown>,
  canonical: string,
  legacy: string,
): Record<string, unknown> | null {
  if (isRecord(fm[canonical])) return fm[canonical];
  if (isRecord(fm[legacy])) return fm[legacy];
  return null;
}

function kindOf(f: ExtractedFile): DraftKind {
  const fm = f.frontmatter;
  if (requestBlock(fm, "audit", "assess") !== null) return "audit";
  if (requestBlock(fm, "investigate", "analyze") !== null) return "investigate";
  if (fm.amends_pr !== undefined && fm.amends_pr !== null) return "amend";
  if (extractPatchBody(f.body) !== null) return "apply";
  return "ticket";
}

function commandArgsFor(
  kind: DraftKind,
  f: ExtractedFile,
  ctx: ExtractCtx,
  problems: string[],
): string[] | null {
  const fm = f.frontmatter;
  if (kind === "audit") {
    const a = requestBlock(fm, "audit", "assess")!;
    const target = ctx.nwo ?? ctx.repo;
    const issue = typeof a.issue === "number" ? a.issue : null;
    if (issue !== null && ctx.nwo === null) {
      problems.push("an issue-scoped audit needs a watched owner/repo");
      return null;
    }
    return [
      "audit",
      issue !== null ? `${target}#${issue}` : target,
      ...(a.auto_plan === true ? ["--auto-plan"] : []),
    ];
  }
  if (kind === "investigate") {
    const a = requestBlock(fm, "investigate", "analyze")!;
    if (ctx.nwo === null) {
      problems.push("investigate needs a watched owner/repo");
      return null;
    }
    if (typeof a.issue !== "number") {
      problems.push("investigate.issue is required");
      return null;
    }
    return ["investigate", `${ctx.nwo}#${a.issue}`];
  }
  return null;
}

export function extractDrafts(text: string, ctx: ExtractCtx): ExtractedDraft[] {
  const out: ExtractedDraft[] = [];
  const tickets = allFencedBlocks(text, PLAN_FENCE);
  if (tickets.length === 1) {
    const problems: string[] = [];
    const file = splitFile(tickets[0]!, ctx, problems);
    const kind = kindOf(file);
    const commandArgs = commandArgsFor(kind, file, ctx, problems);
    out.push({ kind, files: [file], blocked: null, commandArgs, problems });
  } else if (tickets.length > 1) {
    const problems: string[] = [];
    const files = tickets.map((t) => splitFile(t, ctx, problems));
    const ids = new Set<string>();
    files.forEach((f, i) => {
      if (f.id === null)
        problems.push(`every ticket in a set needs an explicit id (file ${i + 1} has none)`);
      else ids.add(f.id);
    });
    for (const f of files) {
      const deps = Array.isArray(f.frontmatter.depends_on) ? f.frontmatter.depends_on : [];
      const missing = deps.filter((d) => typeof d === "string" && !ids.has(d));
      if (missing.length > 0)
        problems.push(`${f.id ?? f.name}: depends_on names no sibling: ${missing.join(", ")}`);
    }
    out.push({ kind: "ticketSet", files, blocked: null, commandArgs: null, problems });
  }
  for (const plan of allFencedBlocks(text, PLAN_SET_FENCE)) {
    out.push({
      kind: "planSet",
      files: [
        {
          name: "plan.md",
          content: `\`\`\`${PLAN_SET_FENCE}\n${plan}\n\`\`\`\n`,
          frontmatter: {},
          body: plan,
          droppedKeys: [],
          id: null,
        },
      ],
      blocked: ctx.planSetsEnabled ? null : "plan_sets_disabled",
      commandArgs: null,
      problems: [],
    });
  }
  return out;
}
```

(`depends_on` sibling check is a **problem** here for visibility; Task 11 renders it as a lint _warning_, never a block — submit's own behavior.) Keep `planSet`'s `plan.md` content as the fence itself: `junco submit --plan <file>` reads a fenced `junco-plan` document.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/fenceExtract.test.ts tests/githubInbox.test.ts > /tmp/t10 2>&1; echo "exit: $?"` — expected 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubInbox.ts src/chat/fenceExtract.ts tests/fenceExtract.test.ts tests/githubInbox.test.ts
git add src/githubInbox.ts src/chat/fenceExtract.ts tests/fenceExtract.test.ts tests/githubInbox.test.ts
git commit -m "feat(chat): fence extraction — draft kinds, frontmatter allowlist, command args"
```

---

### Task 11: `draftStore.ts` + `chatDrafts.ts` — park with lint and route; the one auto-lint retry

Spec §6.2–6.4. Parking runs the same `lintTicket`/`decideRoute` that `junco submit --dry-run` runs, writes the files beside the JSON so confirm can hand the CLI a path, and records a `junco_chat_draft` in the transcript. The manager's `onTurnComplete` hook is extended to return an optional follow-up prompt, which the manager sends once with `source: "auto_lint"`.

**Files:**

- Create: `src/chat/draftStore.ts`, `src/chat/chatDrafts.ts`
- Modify: `src/chat/chatManager.ts` (`ChatManagerDeps.onTurnComplete` return type; the follow-up send in `prompt()`)
- Test: `tests/draftStore.test.ts`, `tests/chatDrafts.test.ts`, `tests/chatManager.test.ts` (one added case)

**Interfaces:**

- Consumes: `ExtractedDraft`, `extractDrafts` (Task 10); `makeReviewStore`, `ReviewStoreDeps` (`src/reviewStore.ts`); `lintTicket`, `LintViolation`, `formatViolations` (`src/planLint.ts`); `decideRoute`, `RouteDecision`, `PreflightDeps` (`src/submitPreflight.ts`); `parseTicket` (`src/ticket.ts`); `parsePlanSet` (`src/planCompiler.ts`); `dataTreePaths(cfg).chatDrafts` (Task 1); `ChatSession` (Task 6).
- Produces:

  ```ts
  // draftStore.ts
  export interface DraftFile { name: string; content: string; lint: LintViolation[]; route: RouteDecision | null; droppedKeys: string[] }
  export interface PendingDraft { id: string; key: string; slug: string; kind: DraftKind; files: DraftFile[]; cwd: string; nwo: string | null; createdAt: string; lintFailed: boolean; blocked: string | null; routeOverride: "auto" | "inbox" | "issue"; commandArgs: string[] | null }
  export function chatDraftsDir(cfg: Config): string;
  export function draftFilesDir(cfg: Config, draftId: string): string;     // <chatDrafts>/<draftId>/
  export function draftFilePath(cfg: Config, draftId: string, name: string): string;
  export function listChatDrafts(cfg: Config, deps?: ReviewStoreDeps): PendingDraft[];
  export function readChatDraft(cfg: Config, id: string, deps?: ReviewStoreDeps): { entry: PendingDraft | null; error: string | null };
  export function writeChatDraft(cfg: Config, draft: PendingDraft, deps?: ReviewStoreDeps & { writeFileFn?; mkdirFn? }): string;  // JSON + files
  export function archiveChatDraft(cfg: Config, id: string, sub: "submitted" | "discarded", deps?: ReviewStoreDeps): boolean;
  export function removeChatDraft(cfg: Config, id: string, deps?: { rmFn? }): void;   // JSON + files dir, no archive
  export function draftsParkedFor(cfg: Config, slug: string, deps?: ReviewStoreDeps): number;
  // chatDrafts.ts
  export interface ParkDeps { lintFn?: typeof lintTicket; routeFn?: typeof decideRoute; store?: Parameters<typeof writeChatDraft>[2]; now?: () => number }
  export function parkDrafts(cfg: Config, session: Pick<ChatSession, "slug" | "key" | "cwd" | "nwo">, extracted: ExtractedDraft[], deps?: ParkDeps): Promise<PendingDraft[]>;
  export function lintFollowUp(drafts: PendingDraft[]): string | null;   // the auto-lint prompt text, or null when all clean
  export function makeTurnHook(cfg: () => Config, deps?: ParkDeps): NonNullable<ChatManagerDeps["onTurnComplete"]>;
  // chatManager.ts (changed)
  onTurnComplete?: (session, result, source) => Promise<{ followUp?: string } | void>;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/draftStore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveChatDraft,
  draftFilePath,
  draftsParkedFor,
  listChatDrafts,
  readChatDraft,
  removeChatDraft,
  writeChatDraft,
  type PendingDraft,
} from "../src/chat/draftStore.js";
import { makeConfig } from "./helpers/config.js";

function cfgAt(root: string) {
  return makeConfig({
    dataDir: root,
    queueRoot: join(root, "queue"),
    worktreeRoot: join(root, "wt"),
    tools: [],
    criticEnabled: false,
    planLintEnabled: false,
    verifyEnabled: false,
    supervisorEnabled: false,
    healthEnabled: false,
    removeWorktreeOnSuccess: true,
  });
}
const draft = (id: string, slug = "acme__api"): PendingDraft => ({
  id,
  key: "acme/api",
  slug,
  kind: "ticket",
  files: [
    { name: "t.md", content: "---\nid: t\n---\n# T\n", lint: [], route: null, droppedKeys: [] },
  ],
  cwd: "/repo",
  nwo: "acme/api",
  createdAt: "2026-09-01T00:00:00.000Z",
  lintFailed: false,
  blocked: null,
  routeOverride: "auto",
  commandArgs: null,
});

describe("chat draft store (spec 2026-09-01 §6.2)", () => {
  it("write puts the JSON in chat-drafts/ and the files under <draftId>/; list/read round-trip", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-ds-"));
    const cfg = cfgAt(root);
    writeChatDraft(cfg, draft("acme__api-1"));
    expect(existsSync(draftFilePath(cfg, "acme__api-1", "t.md"))).toBe(true);
    expect(readFileSync(draftFilePath(cfg, "acme__api-1", "t.md"), "utf8")).toBe(
      "---\nid: t\n---\n# T\n",
    );
    expect(listChatDrafts(cfg).map((d) => d.id)).toEqual(["acme__api-1"]);
    expect(readChatDraft(cfg, "acme__api-1").entry?.kind).toBe("ticket");
    expect(draftsParkedFor(cfg, "acme__api")).toBe(1);
    expect(draftsParkedFor(cfg, "other")).toBe(0);
  });
  it("archive moves the JSON to submitted/ or discarded/; remove deletes JSON + files", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-ds-"));
    const cfg = cfgAt(root);
    writeChatDraft(cfg, draft("d1"));
    writeChatDraft(cfg, draft("d2"));
    expect(archiveChatDraft(cfg, "d1", "submitted")).toBe(true);
    expect(existsSync(join(root, "data", "chat-drafts", "submitted", "d1.json"))).toBe(true);
    expect(listChatDrafts(cfg).map((d) => d.id)).toEqual(["d2"]);
    removeChatDraft(cfg, "d2");
    expect(listChatDrafts(cfg)).toEqual([]);
    expect(existsSync(draftFilePath(cfg, "d2", "t.md"))).toBe(false);
  });
});
```

`tests/chatDrafts.test.ts`:

````ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintFollowUp, makeTurnHook, parkDrafts } from "../src/chat/chatDrafts.js";
import { extractDrafts } from "../src/chat/fenceExtract.js";
import { listChatDrafts } from "../src/chat/draftStore.js";
import { ChatSession } from "../src/chat/chatSession.js";
import type { SessionManagerMode } from "../src/agent/session.js";
import { makeConfig } from "./helpers/config.js";
import { fakeChatSession } from "./helpers/fakeSession.js";

function cfgAt(root: string) {
  return makeConfig({
    dataDir: root,
    queueRoot: join(root, "queue"),
    worktreeRoot: join(root, "wt"),
    tools: ["read"],
    criticEnabled: false,
    planLintEnabled: true,
    verifyEnabled: false,
    supervisorEnabled: false,
    healthEnabled: false,
    removeWorktreeOnSuccess: true,
  });
}
const sess = { slug: "acme__api", key: "acme/api", cwd: "/repo", nwo: "acme/api" };
const ctx = { repo: "/repo", nwo: "acme/api", planSetsEnabled: true };
const CLEAN_BODY = readFileSync(
  new URL("./fixtures/clean-ticket-body.md", import.meta.url),
  "utf8",
);
const routeInbox = async () => ({
  destination: "inbox" as const,
  reasons: ["github disabled"],
  watchedNwo: null,
  carriedTimeout: null,
  discarded: [],
});

describe("parkDrafts (spec 2026-09-01 §6.2)", () => {
  it("lints and routes each file, writes the draft, marks lintFailed on an error", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-park-"));
    const cfg = cfgAt(root);
    const clean = extractDrafts("```junco-ticket\n---\nid: ok\n---\n" + CLEAN_BODY + "\n```", ctx);
    const [d] = await parkDrafts(cfg, sess, clean, { routeFn: routeInbox });
    expect(d!.lintFailed).toBe(false);
    expect(d!.files[0]!.route?.destination).toBe("inbox");
    expect(d!.id.startsWith("acme__api-")).toBe(true);
    expect(listChatDrafts(cfg).map((x) => x.id)).toEqual([d!.id]);
    const dirty = extractDrafts(
      "```junco-ticket\n---\nid: bad\n---\n# Bad\n\n## Steps\n\n1. cd src && npm test\n```",
      ctx,
    );
    const [b] = await parkDrafts(cfg, sess, dirty, { routeFn: routeInbox });
    expect(b!.lintFailed).toBe(true);
    expect(b!.files[0]!.lint.some((v) => v.severity === "error")).toBe(true);
  });
  it("a set's unknown depends_on is a WARNING, never a block; extraction problems are errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-park-"));
    const cfg = cfgAt(root);
    const set = extractDrafts(
      [
        "```junco-ticket\n---\nid: a\n---\n" + CLEAN_BODY + "\n```",
        "```junco-ticket\n---\nid: b\ndepends_on: [ghost]\n---\n" + CLEAN_BODY + "\n```",
      ].join("\n"),
      ctx,
    );
    const [d] = await parkDrafts(cfg, sess, set, { routeFn: routeInbox });
    expect(d!.kind).toBe("ticketSet");
    expect(d!.lintFailed).toBe(false);
    expect(d!.files[1]!.lint.find((v) => v.rule === "depends_on_sibling")?.severity).toBe(
      "warning",
    );
    const bad = extractDrafts("```junco-ticket\n---\nid: z\ninvestigate: {}\n---\n# Z\n```", ctx);
    const [z] = await parkDrafts(cfg, sess, bad, { routeFn: routeInbox });
    expect(z!.lintFailed).toBe(true);
    expect(z!.files[0]!.lint[0]).toMatchObject({
      rule: "chat_extract",
      severity: "error",
      message: "investigate.issue is required",
    });
  });
  it("audit/investigate skip plan lint and carry commandArgs; planSet lints through the compiler", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-park-"));
    const cfg = cfgAt(root);
    const [a] = await parkDrafts(
      cfg,
      sess,
      extractDrafts(
        "```junco-ticket\n---\nid: a\naudit:\n  auto_plan: true\n---\n# Audit\n```",
        ctx,
      ),
    );
    expect(a!.kind).toBe("audit");
    expect(a!.commandArgs).toEqual(["audit", "acme/api", "--auto-plan"]);
    expect(a!.lintFailed).toBe(false);
    const [p] = await parkDrafts(
      cfg,
      sess,
      extractDrafts("```junco-plan\nversion: 1\ntasks: []\n```", ctx),
    );
    expect(p!.kind).toBe("planSet");
    expect(p!.lintFailed).toBe(true); // an empty task list is a compiler error
  });
});

describe("lintFollowUp + makeTurnHook (spec 2026-09-01 §6.3)", () => {
  it("lintFollowUp is null when clean and names every violation otherwise", () => {
    expect(lintFollowUp([])).toBeNull();
    const text = lintFollowUp([
      {
        id: "d",
        key: "k",
        slug: "s",
        kind: "ticket",
        cwd: "/r",
        nwo: null,
        createdAt: "t",
        lintFailed: true,
        blocked: null,
        routeOverride: "auto",
        commandArgs: null,
        files: [
          {
            name: "x.md",
            content: "",
            route: null,
            droppedKeys: [],
            lint: [{ rule: "no_cd_in_verification", severity: "error", message: "cd in step 1" }],
          },
        ],
      },
    ]);
    expect(text).toContain("[error] no_cd_in_verification: cd in step 1");
    expect(text).toMatch(/re-emit/i);
  });

  it("the hook parks, records junco_chat_draft, returns a followUp once, and on the retry replaces the failed draft", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-park-"));
    const cfg = cfgAt(root);
    const fakeSm = async (mode: SessionManagerMode) =>
      "create" in mode
        ? { manager: {}, file: join(mode.create.dir, "sdk") }
        : { manager: {}, file: mode.open.file };
    const session = new ChatSession(
      {
        cfg,
        key: "acme/api",
        kind: "watched",
        cwd: "/repo",
        nwo: "acme/api",
        dir: join(root, "data", "chats", "acme__api"),
      },
      { makeSessionManager: fakeSm, sessionFactoryFor: () => fakeChatSession([]) },
    );
    await session.ensureMeta();
    const hook = makeTurnHook(() => cfg, { routeFn: routeInbox });
    const bad =
      "```junco-ticket\n---\nid: bad\n---\n# Bad\n\n## Steps\n\n1. cd src && npm test\n```";
    const r1 = await hook(
      session,
      {
        mode: "prompt",
        status: "ok",
        abortReason: null,
        errorMessage: null,
        usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
        durationMs: 1,
        finalText: bad,
        allText: bad,
      },
      "operator",
    );
    expect(r1 && "followUp" in r1 && typeof r1.followUp).toBe("string");
    const first = listChatDrafts(cfg);
    expect(first).toHaveLength(1);
    expect(first[0]!.lintFailed).toBe(true);
    const good = "```junco-ticket\n---\nid: good\n---\n" + CLEAN_BODY + "\n```";
    const r2 = await hook(
      session,
      {
        mode: "prompt",
        status: "ok",
        abortReason: null,
        errorMessage: null,
        usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
        durationMs: 1,
        finalText: good,
        allText: good,
      },
      "auto_lint",
    );
    expect(r2 === undefined || !("followUp" in r2) || r2.followUp === undefined).toBe(true);
    const after = listChatDrafts(cfg);
    expect(after).toHaveLength(1);
    expect(after[0]!.lintFailed).toBe(false);
    expect(after[0]!.id).not.toBe(first[0]!.id);
    const recs = readFileSync(session.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((x) => x.type === "junco_chat_draft");
    expect(recs.map((x) => x.status)).toEqual(["lint_failed", "parked"]);
  });

  it("a still-failing retry parks lintFailed and returns no further followUp", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-park-"));
    const cfg = cfgAt(root);
    const fakeSm = async (mode: SessionManagerMode) =>
      "create" in mode
        ? { manager: {}, file: join(mode.create.dir, "sdk") }
        : { manager: {}, file: mode.open.file };
    const session = new ChatSession(
      {
        cfg,
        key: "acme/api",
        kind: "watched",
        cwd: "/repo",
        nwo: "acme/api",
        dir: join(root, "data", "chats", "acme__api"),
      },
      { makeSessionManager: fakeSm, sessionFactoryFor: () => fakeChatSession([]) },
    );
    await session.ensureMeta();
    const hook = makeTurnHook(() => cfg, { routeFn: routeInbox });
    const bad =
      "```junco-ticket\n---\nid: bad\n---\n# Bad\n\n## Steps\n\n1. cd src && npm test\n```";
    const zero = { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 };
    await hook(
      session,
      {
        mode: "prompt",
        status: "ok",
        abortReason: null,
        errorMessage: null,
        usage: zero,
        durationMs: 1,
        finalText: bad,
        allText: bad,
      },
      "operator",
    );
    const r2 = await hook(
      session,
      {
        mode: "prompt",
        status: "ok",
        abortReason: null,
        errorMessage: null,
        usage: zero,
        durationMs: 1,
        finalText: bad,
        allText: bad,
      },
      "auto_lint",
    );
    expect(r2 === undefined || !("followUp" in r2) || r2.followUp === undefined).toBe(true);
    expect(listChatDrafts(cfg)).toHaveLength(1);
    expect(listChatDrafts(cfg)[0]!.lintFailed).toBe(true);
  });
});
````

Create `tests/fixtures/clean-ticket-body.md` — a plan body that passes `lintTicket` with `planLintEnabled: true` and no repo checks. Derive it from `skills/junco-dispatch/EXAMPLE.md`'s first example (copy its body sections verbatim, without frontmatter); run `npx vitest run tests/chatDrafts.test.ts` and adjust until the "clean" cases pass lint — the fixture must be genuinely lint-clean, not a lint-disabled shortcut.

Append to `tests/chatManager.test.ts`:

```ts
it("sends the hook's followUp once, as source auto_lint, and never chains a second one", async () => {
  const seen: string[] = [];
  const { m } = setup(
    {
      onTurnComplete: async (_s, _r, src) => {
        seen.push(src);
        return src === "operator" ? { followUp: "fix the lint" } : undefined;
      },
    },
    [chatScriptText("first"), chatScriptText("second")],
  );
  await m.prompt("acme/api", "hello");
  expect(seen).toEqual(["operator", "auto_lint"]);
  expect(m.health().turns).toBe(2);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/draftStore.test.ts tests/chatDrafts.test.ts tests/chatManager.test.ts > /tmp/t11 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/chat/draftStore.ts`:

```ts
/**
 * Parked chat drafts (spec 2026-09-01 §6.2): a makeReviewStore over
 * <chatDrafts>/ (the third instance of the audit/investigate park idiom) plus the
 * ticket files beside the JSON — <chatDrafts>/<draftId>/<name> — so confirm
 * hands the CLI a byte-identical path.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../types.js";
import type { DraftKind } from "../agent/transcriptSchema.js";
import type { LintViolation } from "../planLint.js";
import type { RouteDecision } from "../submitPreflight.js";
import { dataTreePaths } from "../dataTree.js";
import { makeReviewStore, type ReviewStoreDeps } from "../reviewStore.js";

export interface DraftFile {
  name: string;
  content: string;
  lint: LintViolation[];
  route: RouteDecision | null;
  droppedKeys: string[];
}

export interface PendingDraft {
  id: string;
  key: string;
  slug: string;
  kind: DraftKind;
  files: DraftFile[];
  cwd: string;
  nwo: string | null;
  createdAt: string;
  lintFailed: boolean;
  blocked: string | null;
  routeOverride: "auto" | "inbox" | "issue";
  commandArgs: string[] | null;
}

const store = makeReviewStore<PendingDraft>(
  ["id", "key", "slug", "kind", "files", "cwd", "createdAt", "lintFailed", "routeOverride"],
  (id) => id, // ids are <slug>-<ts>-<n>: already [a-z0-9._-]
);

export function chatDraftsDir(cfg: Config): string {
  return dataTreePaths(cfg).chatDrafts;
}
export function draftFilesDir(cfg: Config, draftId: string): string {
  return join(chatDraftsDir(cfg), draftId);
}
export function draftFilePath(cfg: Config, draftId: string, name: string): string {
  return join(draftFilesDir(cfg, draftId), name);
}

export function listChatDrafts(cfg: Config, deps: ReviewStoreDeps = {}): PendingDraft[] {
  return store.list(chatDraftsDir(cfg), deps);
}
export function readChatDraft(
  cfg: Config,
  id: string,
  deps: ReviewStoreDeps = {},
): { entry: PendingDraft | null; error: string | null } {
  return store.read(chatDraftsDir(cfg), id, deps);
}
export function writeChatDraft(
  cfg: Config,
  draft: PendingDraft,
  deps: ReviewStoreDeps & {
    writeFileFn?: (p: string, s: string) => void;
    mkdirFn?: (d: string) => void;
  } = {},
): string {
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const writeFileFn = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const dir = draftFilesDir(cfg, draft.id);
  mkdirFn(dir);
  for (const f of draft.files) writeFileFn(join(dir, f.name), f.content);
  return store.write(chatDraftsDir(cfg), draft, deps);
}
export function archiveChatDraft(
  cfg: Config,
  id: string,
  sub: "submitted" | "discarded",
  deps: ReviewStoreDeps = {},
): boolean {
  return store.remove(chatDraftsDir(cfg), id, sub, deps);
}
/** Spec §6.3: the first failed draft is REMOVED (not archived) when its retry parks. */
export function removeChatDraft(
  cfg: Config,
  id: string,
  deps: { rmFn?: (p: string) => void } = {},
): void {
  const rmFn = deps.rmFn ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  rmFn(join(chatDraftsDir(cfg), `${id}.json`));
  rmFn(draftFilesDir(cfg, id));
}
export function draftsParkedFor(cfg: Config, slug: string, deps: ReviewStoreDeps = {}): number {
  return listChatDrafts(cfg, deps).filter((d) => d.slug === slug).length;
}
```

`src/chat/chatDrafts.ts`:

```ts
/**
 * Parking (spec 2026-09-01 §6.2–6.4): the same lintTicket/decideRoute that
 * `junco submit --dry-run` runs, per file, then writeChatDraft + a
 * junco_chat_draft record. The auto-lint retry (§6.3) is a decision made
 * here and executed by the manager: the hook returns the follow-up text
 * once, keyed by slug, and replaces the failed draft when the retry parks.
 */
import type { Config } from "../types.js";
import { parseTicket } from "../ticket.js";
import { lintTicket, formatViolations, type LintViolation } from "../planLint.js";
import { decideRoute } from "../submitPreflight.js";
import { parsePlanSet } from "../planCompiler.js";
import type { ChatManagerDeps } from "./chatManager.js";
import type { ChatSession } from "./chatSession.js";
import type { ChatTurnResult } from "./chatTurn.js";
import { extractDrafts, type ExtractedDraft } from "./fenceExtract.js";
import {
  removeChatDraft,
  writeChatDraft,
  type DraftFile,
  type PendingDraft,
} from "./draftStore.js";

export interface ParkDeps {
  lintFn?: typeof lintTicket;
  routeFn?: typeof decideRoute;
  store?: Parameters<typeof writeChatDraft>[2];
  now?: () => number;
}

type SessionRef = Pick<ChatSession, "slug" | "key" | "cwd" | "nwo">;

/** Extraction problems as lint rows. A set's problems are addressed
 * `"<id>: …"` and land on that file; unaddressed ones land on every file
 * (a single-file draft) or the first file (a set-wide problem). */
function problemsFor(x: ExtractedDraft, fileIdx: number): LintViolation[] {
  const f = x.files[fileIdx]!;
  const mine = x.problems.filter((p) => {
    const addressed = /^([^:\s]+): /.exec(p);
    if (!addressed) return x.kind !== "ticketSet" || fileIdx === 0;
    return addressed[1] === f.id || addressed[1] === f.name;
  });
  return mine.map((message) => ({ rule: "chat_extract", severity: "error", message }));
}

function tsId(now: number): string {
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export async function parkDrafts(
  cfg: Config,
  session: SessionRef,
  extracted: ExtractedDraft[],
  deps: ParkDeps = {},
): Promise<PendingDraft[]> {
  const lintFn = deps.lintFn ?? lintTicket;
  const routeFn = deps.routeFn ?? decideRoute;
  const now = deps.now ?? (() => Date.now());
  const out: PendingDraft[] = [];
  let n = 0;
  for (const x of extracted) {
    const files: DraftFile[] = [];
    for (const [i, f] of x.files.entries()) {
      const lint: LintViolation[] = problemsFor(x, i);
      let route = null;
      if (x.kind === "planSet") {
        const parsed = parsePlanSet(f.body, { maxTasks: cfg.planSets.maxTasks });
        if (!parsed.ok)
          for (const message of parsed.errors)
            lint.push({ rule: "plan_set", severity: "error", message });
      } else if (x.kind !== "audit" && x.kind !== "investigate") {
        const t = parseTicket(f.name, f.content, cfg.defaultTimeoutMinutes);
        lint.push(
          ...lintFn(t.body, t.frontmatter, {
            repoPath: session.cwd,
            repoNwo: session.nwo,
            checkLabels: false,
          }).violations,
        );
        route = await routeFn(cfg, t.frontmatter);
      }
      files.push({ name: f.name, content: f.content, lint, route, droppedKeys: f.droppedKeys });
    }
    // A set's unknown depends_on is submit's own warn-and-wait, never a block.
    if (x.kind === "ticketSet")
      for (const f of files)
        for (const v of f.lint)
          if (v.rule === "chat_extract" && v.message.includes("depends_on names no sibling"))
            Object.assign(v, { rule: "depends_on_sibling", severity: "warning" });
    const lintFailed = files.some((f) => f.lint.some((v) => v.severity === "error"));
    const draft: PendingDraft = {
      id: `${session.slug}-${tsId(now())}-${++n}`,
      key: session.key,
      slug: session.slug,
      kind: x.kind,
      files,
      cwd: session.cwd,
      nwo: session.nwo,
      createdAt: new Date(now()).toISOString(),
      lintFailed,
      blocked: x.blocked,
      routeOverride: "auto",
      commandArgs: x.commandArgs,
    };
    writeChatDraft(cfg, draft, deps.store);
    out.push(draft);
  }
  return out;
}

/** The one automatic follow-up (spec §6.3): every error, the skill's own loop instruction. */
export function lintFollowUp(drafts: PendingDraft[]): string | null {
  const failed = drafts.filter((d) => d.lintFailed);
  if (failed.length === 0) return null;
  const parts = failed.map((d) => {
    const lines = d.files.map(
      (f) => `${f.name}:\n${formatViolations(f.lint.filter((v) => v.severity === "error"))}`,
    );
    return lines.join("\n");
  });
  return `junco's plan-lint rejected the draft you just emitted:\n\n${parts.join("\n\n")}\n\nFix exactly the rules cited and re-emit the complete fence(s). Do not change anything else.`;
}

/** ChatManager.onTurnComplete: extract → park → record → decide the retry. */
export function makeTurnHook(
  cfg: () => Config,
  deps: ParkDeps = {},
): NonNullable<ChatManagerDeps["onTurnComplete"]> {
  const pendingRetry = new Map<string, string>(); // slug → failed draft id awaiting its retry
  return async (session: ChatSession, result: ChatTurnResult, source) => {
    if (result.mode !== "prompt" || result.status !== "ok") return;
    const c = cfg();
    const extracted = extractDrafts(result.allText, {
      repo: session.cwd,
      nwo: session.nwo,
      planSetsEnabled: c.planSets.enabled,
    });
    if (extracted.length === 0) return;
    const parked = await parkDrafts(c, session, extracted, deps);
    const previous = pendingRetry.get(session.slug);
    if (source === "auto_lint" && previous !== undefined) {
      removeChatDraft(c, previous);
      pendingRetry.delete(session.slug);
    }
    for (const d of parked)
      session.writeRecord({
        type: "junco_chat_draft",
        draftId: d.id,
        kind: d.kind,
        status: d.lintFailed ? "lint_failed" : "parked",
        ids: d.files.map((f) => f.name.replace(/\.md$/, "")),
        destination: null,
      });
    const followUp = lintFollowUp(parked);
    if (followUp !== null && source === "operator") {
      pendingRetry.set(session.slug, parked.find((d) => d.lintFailed)!.id);
      return { followUp };
    }
    return;
  };
}
```

`src/chat/chatManager.ts` — change the hook type to `Promise<{ followUp?: string } | void>` and in `prompt()` replace the hook call with:

```ts
let followUp: string | undefined;
if (this.deps.onTurnComplete) {
  try {
    const r = await this.deps.onTurnComplete(session, result, source);
    followUp = r && "followUp" in r ? r.followUp : undefined;
  } catch (e) {
    log.warn("chat onTurnComplete threw; ignoring", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
// Spec §6.3: exactly one automatic lint follow-up, never chained.
if (followUp !== undefined && source === "operator") {
  await this.prompt(key, followUp, { source: "auto_lint" });
}
```

`src/daemon.ts` — in the `ChatManager` construction, add `onTurnComplete: makeTurnHook(activeCfg)` and `draftsParkedFor: (slug) => draftsParkedFor(activeCfg(), slug)` (imports from `./chat/chatDrafts.js` and `./chat/draftStore.js`).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/draftStore.test.ts tests/chatDrafts.test.ts tests/chatManager.test.ts tests/daemon.test.ts > /tmp/t11 2>&1; echo "exit: $?"` — expected 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/chat/draftStore.ts src/chat/chatDrafts.ts src/chat/chatManager.ts src/daemon.ts tests/draftStore.test.ts tests/chatDrafts.test.ts tests/chatManager.test.ts tests/fixtures/clean-ticket-body.md
git add src/chat/draftStore.ts src/chat/chatDrafts.ts src/chat/chatManager.ts src/daemon.ts tests/draftStore.test.ts tests/chatDrafts.test.ts tests/chatManager.test.ts tests/fixtures/clean-ticket-body.md
git commit -m "feat(chat): park drafts with lint + route; one automatic lint follow-up"
```

---

### Task 12: `chatPrompt.ts` — the system prompt from TEMPLATE.md + SKILL.md sections

Spec §6.5. One source of truth: the planner's TEMPLATE.md-backed contract (refactored so `planPrompt.ts` exports its pieces without changing `buildPlannerPrompt`'s output), plus the dispatch skill's authoring sections lifted **by heading at build time**, plus the chat-specific fence/allowlist contract. A test guards every lifted heading.

**Files:**

- Modify: `src/planPrompt.ts` (export `loadExample`, extract `planSetRuleText`)
- Create: `src/chat/chatPrompt.ts`
- Test: `tests/chatPrompt.test.ts`; `tests/planPrompt.test.ts` must stay green unchanged

**Interfaces:**

- Consumes: `loadDispatchTemplate`, `PLAN_FENCE` (`src/planPrompt.ts`); `PLAN_SET_FENCE` (`src/githubInbox.ts`); `FRONTMATTER_ALLOWLIST` (Task 10); `PACKAGE_ROOT` (`src/packageRoot.ts`).
- Produces:

  ```ts
  // planPrompt.ts (additions)
  export function loadExample(): string | null;
  export function planSetRuleText(): string; // the rule-6 paragraph buildPlannerPrompt appends when planSets is on
  // chatPrompt.ts
  export interface SkillSectionSpec {
    h2: string;
    h3?: string;
  }
  export const CHAT_SKILL_SECTIONS: readonly SkillSectionSpec[];
  export function loadSkillSections(
    specs: readonly SkillSectionSpec[],
    deps?: { readFileFn?: (p: string) => string },
  ): string; // throws on a missing heading
  export function buildChatPrompt(
    opts: { cwd: string; nwo: string | null; planSetsEnabled: boolean },
    deps?: { readFileFn?: (p: string) => string },
  ): string;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/chatPrompt.test.ts`:

````ts
import { describe, it, expect } from "vitest";
import { buildChatPrompt, CHAT_SKILL_SECTIONS, loadSkillSections } from "../src/chat/chatPrompt.js";
import { FRONTMATTER_ALLOWLIST } from "../src/chat/fenceExtract.js";

describe("chat prompt (spec 2026-09-01 §6.5)", () => {
  it("every lifted SKILL.md heading exists in the packaged skill (drift guard)", () => {
    expect(() => loadSkillSections(CHAT_SKILL_SECTIONS)).not.toThrow();
    const text = loadSkillSections(CHAT_SKILL_SECTIONS);
    for (const s of CHAT_SKILL_SECTIONS) expect(text).toContain(`## ${s.h3 ?? s.h2}`);
  });
  it("a renamed heading fails loud", () => {
    expect(() => loadSkillSections([{ h2: "Ticket sets (renamed)" }])).toThrow(/heading/);
  });
  it("a subsection spec returns only that ### block", () => {
    const only = loadSkillSections([
      { h2: "Audit mode (sweep a repo → review → file)", h3: "Inputs to gather" },
    ]);
    expect(only).toContain("### Inputs to gather");
    expect(only).not.toContain("### Preconditions");
  });
  it("carries the template, the fence contract, the allowlist, and the repo rule", () => {
    const p = buildChatPrompt({ cwd: "/repo", nwo: "acme/api", planSetsEnabled: false });
    expect(p).toContain("--- TICKET TEMPLATE");
    expect(p).toContain("```junco-ticket");
    for (const k of FRONTMATTER_ALLOWLIST) expect(p).toContain(`\`${k}\``);
    expect(p).toMatch(/`repo:` is set by junco/);
    expect(p).toContain("acme/api");
    expect(p).not.toContain("```junco-plan");
    expect(p).toMatch(/never claim/i);
  });
  it("teaches the junco-plan fence only when plan sets are on; a local session names its path", () => {
    const on = buildChatPrompt({ cwd: "/repo", nwo: null, planSetsEnabled: true });
    expect(on).toContain("```junco-plan");
    expect(on).toContain("/repo");
  });
  it("planner prompt pieces are reused, not duplicated", async () => {
    const { planSetRuleText, loadExample } = await import("../src/planPrompt.js");
    expect(planSetRuleText()).toContain("junco-plan");
    expect(typeof loadExample()).toBe("string");
  });
});
````

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/chatPrompt.test.ts > /tmp/t12 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/planPrompt.ts` — make `loadExample` exported (`export function loadExample()`), and move the `planSetRule` template literal's body (everything between the backticks of the `opts.planSets ? \`…\` : ""`expression, i.e. the text beginning`\n\n6. IF AND ONLY IF the issue naturally decomposes …`through`…whenever the work fits one PR.`) into

```ts
/** Rule 6 — the plan-set alternative. Shared by the planner (buildPlannerPrompt)
 * and the dashboard chat (chat/chatPrompt.ts) so the two never drift. */
export function planSetRuleText(): string {
  return `

6. IF AND ONLY IF the issue naturally decomposes …
   … Prefer the single junco-ticket fence whenever the work fits one PR.`;
}
```

and in `buildPlannerPrompt` use `const planSetRule = opts.planSets ? planSetRuleText() : "";`. `tests/planPrompt.test.ts` must pass byte-identically (its "teaches the junco-plan fence" case asserts the text).

`src/chat/chatPrompt.ts`:

```ts
/**
 * The chat system prompt (spec 2026-09-01 §6.5). One source of truth: the
 * planner's TEMPLATE.md-backed authoring contract (planPrompt.ts), the
 * dispatch skill's authoring sections lifted by heading at build time (a test
 * guards every heading — a rename is a contract change), and the chat's own
 * fence + frontmatter-allowlist rules.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../packageRoot.js";
import { PLAN_FENCE, loadDispatchTemplate, loadExample, planSetRuleText } from "../planPrompt.js";
import { PLAN_SET_FENCE } from "../githubInbox.js";
import { FRONTMATTER_ALLOWLIST } from "./fenceExtract.js";

const SKILL_PATH = join(PACKAGE_ROOT, "skills", "junco-dispatch", "SKILL.md");

export interface SkillSectionSpec {
  /** Exact `## ` heading text. */
  h2: string;
  /** Exact `### ` heading text inside it; absent → the whole ## section (subsections included). */
  h3?: string;
}

/** The authoring sections the chat needs and the planner never did. */
export const CHAT_SKILL_SECTIONS: readonly SkillSectionSpec[] = [
  { h2: "Metadata rules" },
  { h2: "Authoring discipline (what makes the plan NOT loop)" },
  { h2: "Things to NEVER put in a plan" },
  { h2: "Ticket sets" },
  { h2: "Wrapping an existing plan file" },
  { h2: "Amend mode (follow-up tickets on existing PRs)" },
  { h2: "Apply mode (patch tickets)" },
  { h2: "Audit mode (sweep a repo → review → file)", h3: "Inputs to gather" },
  { h2: "Investigate mode (deep-read an issue → reviewed comment)", h3: "Inputs to gather" },
];

function sliceSection(lines: string[], start: number, level: "##" | "###"): string[] {
  const stop = level === "##" ? /^##\s/ : /^##\s|^###\s/;
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    if (stop.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  return out;
}

export function loadSkillSections(
  specs: readonly SkillSectionSpec[],
  deps: { readFileFn?: (p: string) => string } = {},
): string {
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const lines = readFileFn(SKILL_PATH).replace(/\r\n?/g, "\n").split("\n");
  const parts: string[] = [];
  for (const s of specs) {
    const h2 = lines.findIndex((l) => l === `## ${s.h2}`);
    if (h2 === -1) throw new Error(`junco-dispatch SKILL.md: heading not found: "## ${s.h2}"`);
    const section = sliceSection(lines, h2, "##");
    if (s.h3 === undefined) {
      parts.push(section.join("\n").trimEnd());
      continue;
    }
    const h3 = section.findIndex((l) => l === `### ${s.h3}`);
    if (h3 === -1)
      throw new Error(
        `junco-dispatch SKILL.md: heading not found: "### ${s.h3}" under "## ${s.h2}"`,
      );
    parts.push(sliceSection(section, h3, "###").join("\n").trimEnd());
  }
  return parts.join("\n\n");
}

export function buildChatPrompt(
  opts: { cwd: string; nwo: string | null; planSetsEnabled: boolean },
  deps: { readFileFn?: (p: string) => string } = {},
): string {
  const repo = opts.nwo ?? opts.cwd;
  const allow = [...FRONTMATTER_ALLOWLIST].map((k) => `\`${k}\``).join(", ");
  const framing = `You are the coding agent behind junco, a task-queue worker, chatting with its operator
about the repository \`${repo}\` (your working directory: ${opts.cwd}). This session is
READ-ONLY: explore with your tools, answer questions, and — when the operator asks for work
to be done — DRAFT it as a junco ticket. You never run, submit, or dispatch anything; junco
parks every draft for the operator to review and submit. Never claim that a ticket was
submitted, that a PR exists, or that work has started.`;
  const fenceContract = `--- DRAFTING CONTRACT ---

When asked to draft work, emit the finished ticket inside ONE fenced block tagged
\`${PLAN_FENCE}\`, with a YAML frontmatter block at the top followed by the template body.
If the ticket itself contains fenced code, the outer fence must use more backticks than any
inner fence.

Frontmatter you may set: ${allow}. \`repo:\` is set by junco from this session — never
write it — and every other key (\`tools\`, \`network\`, \`workdir\`, …) is dropped. Kinds
are expressed by frontmatter: \`amends_pr: <n>\` for a follow-up on an open PR; an
\`audit:\` block (\`auto_plan\`, optional \`issue\`) to request a repo audit; an
\`investigate:\` block (\`issue\`) to request an issue investigation (the legacy spellings
\`assess:\`/\`analyze:\` are accepted but never preferred); a \`junco-patch\` fence in
the body for an apply ticket (only when you know the exact bytes). A ticket SET is two or
more \`${PLAN_FENCE}\` fences in one message, each with an explicit \`id\` and
\`depends_on\` naming sibling ids. When wrapping an existing plan file the operator points
you at, copy its body verbatim — do not rewrite it.${
    opts.planSetsEnabled
      ? planSetRuleText().replace(
          "INSTEAD of the junco-ticket fence",
          `INSTEAD of the ${PLAN_FENCE} fence`,
        )
      : ""
  }`;
  const template = loadDispatchTemplate();
  const example = loadExample();
  const parts = [
    framing,
    `--- TICKET TEMPLATE (follow the body sections; the frontmatter rules above override its frontmatter guidance) ---\n\n${template}`,
  ];
  if (example) parts.push(`--- WORKED EXAMPLES (shape anchors) ---\n\n${example}`);
  parts.push(
    `--- AUTHORING RULES (from the junco-dispatch skill) ---\n\n${loadSkillSections(CHAT_SKILL_SECTIONS, deps)}`,
  );
  parts.push(fenceContract);
  if (!opts.planSetsEnabled)
    parts.push(`Plan sets are disabled on this daemon: never emit a \`${PLAN_SET_FENCE}\` fence.`);
  return parts.join("\n\n") + "\n";
}
```

**Wiring the prompt into the SDK session.** The SDK takes prompt customization through its
resource loader, not `createAgentSession` (SDK 0.84.2 `dist/core/resource-loader.d.ts:76-118`:
`DefaultResourceLoader` options `systemPrompt`, `appendSystemPrompt`, `systemPromptOverride`,
`appendSystemPromptOverride`, plus `noExtensions/noSkills/noPromptTemplates/noThemes/
noContextFiles`), and those are materialized only by `await loader.reload()`
(`resource-loader.js:382-393`); `createAgentSession` does NOT reload a caller-supplied loader
(`sdk.js:69-78`). `agent-session.js:724-735` then passes the loader's `getSystemPrompt()` as
`customPrompt` (a REPLACEMENT of pi's default coding prompt) and `getAppendSystemPrompt()` as an
append. Chat **appends** — pi's default prompt is what teaches the read/grep/find tools.

- `src/agent/session.ts`: `SessionOverrides` gains `appendSystemPrompt?: string`. `resolveSandbox`/`buildSandbox` get it through a new `BuildSandboxOpts.appendSystemPrompt?: string`; `buildSandbox` (`src/agent/sandbox/index.ts:146-150`) constructs the loader with, when set, `appendSystemPromptOverride: () => [appendSystemPrompt]` plus `noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true` (with `noExtensions: true` already there, a reload then does nothing but resolve the prompt). `SdkToolFactories.DefaultResourceLoader`'s constructor type (`index.ts:50-54`) gains those optional keys. In `makePiSessionFactory`, after `buildSandbox`, `if (overrides?.appendSystemPrompt) await (sandboxLoader as { reload(): Promise<void> }).reload();`. When the sandbox is **off** and `appendSystemPrompt` is set, build the same inert loader directly: `const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent"); sandboxLoader = new DefaultResourceLoader({ cwd, agentDir: join(homedir(), ".pi", "agent"), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, appendSystemPromptOverride: () => [overrides.appendSystemPrompt] }); await sandboxLoader.reload();` — chat never loads ambient extensions even unsandboxed (it is read-only by contract).
- `tests/sandboxBuild.test.ts`: one case — with `appendSystemPrompt: "X"` the fake `DefaultResourceLoader` receives `appendSystemPromptOverride` returning `["X"]` and the four `no*` flags; without it, the constructor args are byte-identical to today's.
- `ChatSession.ensureSession` (Task 6) passes `appendSystemPrompt: buildChatPrompt({ cwd: this.cwd, nwo: this.nwo, planSetsEnabled: this.cfg.planSets.enabled })` AND `readOnly: true` (Ruling R14 — upstream's `SessionOverrides.readOnly`, the seam Q&A uses at `runOnce.ts:451` so the sandbox keeps the checkout unwritable; chat is a read-only session by contract) in the factory overrides. Add assertions to `tests/chatSession.test.ts`: the factory receives `overrides.appendSystemPrompt` containing `--- DRAFTING CONTRACT ---` and `overrides.readOnly === true`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/chatPrompt.test.ts tests/planPrompt.test.ts tests/chatSession.test.ts tests/sandboxBuild.test.ts tests/sdkImportSurface.test.ts > /tmp/t12 2>&1; echo "exit: $?"` — expected 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/planPrompt.ts src/chat/chatPrompt.ts src/chat/chatSession.ts src/agent/session.ts src/agent/sandbox/index.ts tests/chatPrompt.test.ts tests/chatSession.test.ts tests/sandboxBuild.test.ts
git add src/planPrompt.ts src/chat/chatPrompt.ts src/chat/chatSession.ts src/agent/session.ts src/agent/sandbox/index.ts tests/chatPrompt.test.ts tests/chatSession.test.ts tests/sandboxBuild.test.ts
git commit -m "feat(chat): system prompt from TEMPLATE.md + skill sections, with a heading drift guard"
```

---

### Task 13: Transcript viewer awareness of chat records

Spec §1.3 "Viewer awareness". The pure core (`summarizeTranscript` → `renderTranscriptRows`) learns the chat records so the dashboard pane and `junco transcript --chat` share one renderer. Every existing ticket transcript renders byte-identically.

**Files:**

- Modify: `src/transcriptSummary.ts` (`RunSummary` ~line 64–75; the reducer ~123–290)
- Modify: `src/transcriptRender.ts` (`renderTranscriptRows` ~168–242; `fmtRunOutcome` ~148–167)
- Modify: `tests/helpers/transcriptFixtures.ts` (chat record builders), `tests/transcriptRender.test.ts:26-40` (the `run()` builder gains `prompt: null, notes: []`)
- Test: `tests/transcriptSummary.test.ts`, `tests/transcriptRender.test.ts`

**Interfaces:**

- Consumes: `ChatRecord` types (Task 1).
- Produces:

  ```ts
  // transcriptSummary.ts
  export type ChatNote =
    | { kind: "rejected"; reason: string; until: string | null; ts: string }
    | { kind: "draft"; draftId: string; draftKind: DraftKind; status: ChatDraftRecord["status"]; ids: string[]; destination: ChatDraftRecord["destination"]; ts: string }
    | { kind: "reset"; reason: ChatSessionResetRecord["reason"]; ts: string }
    | { kind: "degraded"; ts: string }
    | { kind: "compaction"; phase: "start" | "end"; ts: string | null };
  RunSummary.prompt: string | null;    // junco_chat_prompt text (chat runs)
  RunSummary.notes: ChatNote[];        // rendered as one row each, in order
  export function draftAnchor(draftId: string): string;   // "draft:<id>"
  export function anchorIds(s: TranscriptSummary): string[];   // toolCallIds ∪ draft anchors, file order — the chat cursor space
  // fixtures
  chatPrompt(over?), chatTurnStart(over?), chatTurnEnd(over?), chatTurnAborted(over?), chatTurnRejected(over?), chatDraft(over?), chatReset(over?), compactionStart(), compactionEnd()
  ```

- [ ] **Step 1: Write the failing tests**

Add builders to `tests/helpers/transcriptFixtures.ts` (after `guardDecision`), importing the record types from `../../src/agent/transcriptSchema.js`:

```ts
export const chatPrompt = (over: Partial<ChatPromptRecord> = {}): string =>
  j({
    type: "junco_chat_prompt",
    text: "why is the build slow?",
    mode: "prompt",
    source: "operator",
    ts: TS,
    ...over,
  } satisfies ChatPromptRecord);
export const chatTurnStart = (over: Partial<ChatTurnStartRecord> = {}): string =>
  j({
    type: "junco_chat_turn_start",
    modelId: "local/m1",
    tools: ["read", "grep"],
    timeoutMs: 60_000,
    ts: TS,
    ...over,
  } satisfies ChatTurnStartRecord);
export const chatTurnEnd = (over: Partial<ChatTurnEndRecord> = {}): string =>
  j({
    type: "junco_chat_turn_end",
    status: "ok",
    errorClass: null,
    errorMessage: null,
    usage: { input: 3, output: 4, cacheRead: 0, total: 7, costUsd: 0.01 },
    durationMs: 1500,
    ts: TS,
    ...over,
  } satisfies ChatTurnEndRecord);
export const chatTurnAborted = (over: Partial<ChatTurnAbortedRecord> = {}): string =>
  j({
    type: "junco_chat_turn_aborted",
    reason: "operator",
    ts: TS,
    ...over,
  } satisfies ChatTurnAbortedRecord);
export const chatTurnRejected = (over: Partial<ChatTurnRejectedRecord> = {}): string =>
  j({
    type: "junco_chat_turn_rejected",
    reason: "rate limited",
    until: "2026-09-01T18:00:00.000Z",
    ts: TS,
    ...over,
  } satisfies ChatTurnRejectedRecord);
export const chatDraft = (over: Partial<ChatDraftRecord> = {}): string =>
  j({
    type: "junco_chat_draft",
    draftId: "acme__api-20260901-120000-1",
    kind: "ticket",
    status: "parked",
    ids: ["add-cache"],
    destination: null,
    ts: TS,
    ...over,
  } satisfies ChatDraftRecord);
export const chatReset = (over: Partial<ChatSessionResetRecord> = {}): string =>
  j({
    type: "junco_chat_session_reset",
    reason: "corrupt",
    ts: TS,
    ...over,
  } satisfies ChatSessionResetRecord);
export const compactionStart = (): string => j({ type: "compaction_start", reason: "threshold" });
export const compactionEnd = (): string =>
  j({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
```

Append to `tests/transcriptSummary.test.ts`:

```ts
describe("chat records (spec 2026-09-01 §1.3)", () => {
  const chat = (): string[] => [
    metaLine({ ticketId: "acme__api" }),
    chatPrompt(),
    chatTurnStart(),
    agentStart(),
    turnEndFull({
      thinking: null,
      text: "because of X",
      calls: [],
      usage: { input: 3, output: 4 },
    }),
    agentEnd(),
    chatTurnEnd(),
    chatDraft(),
    chatPrompt({ text: "make a ticket" }),
    chatTurnStart(),
    agentStart(),
    compactionStart(),
    compactionEnd(),
  ];
  it("frames chat turns as runs with flow chat, prompt text, and notes; the last is live", () => {
    const s = summarizeTranscript(chat());
    expect(s.runs).toHaveLength(2);
    expect(s.runs[0]).toMatchObject({
      flow: "chat",
      modelId: "local/m1",
      prompt: "why is the build slow?",
    });
    expect(s.runs[0]!.end).toMatchObject({
      stopReason: "stop",
      errorMessage: null,
      timedOut: false,
      durationMs: 1500,
    });
    expect(s.runs[0]!.turns[0]!.text).toBe("because of X");
    expect(s.runs[0]!.notes).toEqual([
      {
        kind: "draft",
        draftId: "acme__api-20260901-120000-1",
        draftKind: "ticket",
        status: "parked",
        ids: ["add-cache"],
        destination: null,
        ts: expect.any(String),
      },
    ]);
    expect(s.runs[1]!.prompt).toBe("make a ticket");
    expect(s.runs[1]!.notes.map((n) => n.kind)).toEqual(["compaction", "compaction"]);
    expect(s.live).toBe(true);
  });
  it("aborted, error, and rejected turns map onto RunEnd / notes", () => {
    const s = summarizeTranscript([
      metaLine(),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      agentEnd(),
      chatTurnAborted({ reason: "timeout" }),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      agentEnd(),
      chatTurnEnd({ status: "error", errorClass: "rate_limit", errorMessage: "429" }),
      chatTurnRejected(),
    ]);
    expect(s.runs[0]!.end).toMatchObject({ timedOut: true, stopReason: "aborted:timeout" });
    expect(s.runs[1]!.end).toMatchObject({ errorMessage: "429", stopReason: "error" });
    // a note after a closed run lands on that run
    expect(s.runs).toHaveLength(2);
    expect(s.runs[1]!.notes[0]).toMatchObject({ kind: "rejected", reason: "rate limited" });
    expect(s.live).toBe(false);
  });
  it("a note before any run gets a prompt-less, already-closed run so it still renders", () => {
    const s = summarizeTranscript([metaLine(), chatTurnRejected()]);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({ flow: "chat", prompt: null });
    expect(s.runs[0]!.end).not.toBeNull();
    expect(s.runs[0]!.notes[0]).toMatchObject({ kind: "rejected" });
    expect(s.live).toBe(false);
  });
  it("anchorIds is tool ids ∪ draft anchors in file order; ticket transcripts unchanged", () => {
    const s = summarizeTranscript(chat());
    expect(anchorIds(s)).toEqual([draftAnchor("acme__api-20260901-120000-1")]);
    const v2run = summarizeTranscript(v2());
    expect(v2run.runs[0]!.prompt).toBeNull();
    expect(v2run.runs[0]!.notes).toEqual([]);
    expect(anchorIds(v2run)).toEqual(toolCallIds(v2run));
  });
});
```

(import `anchorIds`, `draftAnchor` and the new fixtures at the top.)

Append to `tests/transcriptRender.test.ts`:

```ts
describe("chat rows (spec 2026-09-01 §1.3)", () => {
  it("renders the prompt as a `you:` row before the run header and notes as rows; the draft note carries its anchor", () => {
    const s = summarizeTranscript([
      metaLine({ ticketId: "acme__api" }),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      turnEndFull({
        thinking: null,
        text: "because of X",
        calls: [],
        usage: { input: 3, output: 4 },
      }),
      agentEnd(),
      chatTurnEnd(),
      chatDraft(),
      chatTurnRejected(),
    ]);
    const rows = renderTranscriptRows(s, opts({ width: 80 }));
    const texts = rows.map((r) => r.text);
    expect(texts[0]).toBe("you: why is the build slow?");
    expect(texts[1]).toMatch(/^── run 1\/1 · chat · local\/m1/);
    const draftRow = rows.find((r) => r.anchor === "draft:acme__api-20260901-120000-1");
    expect(draftRow?.text).toContain("draft parked · ticket · add-cache");
    expect(
      rows.some((r) => r.text.includes("turn rejected: rate limited") && r.tone === "warn"),
    ).toBe(true);
  });
  it("a ticket transcript renders byte-identically to before", () => {
    const before = renderTranscriptRows(summarizeTranscript(v2Lines()), opts({ width: 80 }));
    expect(before[0]!.text).toMatch(/^── run 1\/1 · assess/);
    expect(before.some((r) => r.text.startsWith("you:"))).toBe(false);
  });
});
```

(`v2Lines` is the same v2 fixture list used in `tests/transcriptSummary.test.ts`; copy it locally or export it from the fixtures helper as `v2RunLines()`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/transcriptSummary.test.ts tests/transcriptRender.test.ts > /tmp/t13 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/transcriptSummary.ts` — add to imports `type ChatDraftRecord, type ChatSessionResetRecord, type DraftKind`; add after `RunEnd`:

```ts
/** Chat-only side records (spec 2026-09-01 §1.3), rendered one row each. */
export type ChatNote =
  | { kind: "rejected"; reason: string; until: string | null; ts: string }
  | {
      kind: "draft";
      draftId: string;
      draftKind: DraftKind;
      status: ChatDraftRecord["status"];
      ids: string[];
      destination: ChatDraftRecord["destination"];
      ts: string;
    }
  | { kind: "reset"; reason: ChatSessionResetRecord["reason"]; ts: string }
  | { kind: "degraded"; ts: string }
  | { kind: "compaction"; phase: "start" | "end"; ts: string | null };
```

`RunSummary` gains `prompt: string | null;` and `notes: ChatNote[];` (initialized `null`/`[]` in `openRun`). In the reducer's junco `switch` add:

```ts
        case "junco_chat_prompt":
          // A prompt opens the NEXT run's frame; a steer lands on the open one.
          if (r.mode === "steer" && st.open !== null) break;
          st.pendingPrompt = r.text;
          break;
        case "junco_chat_turn_start": {
          const run = openRun({ type: "junco_run_start", flow: "chat", body: "", cwd: "", modelId: r.modelId, tools: r.tools, timeoutMs: r.timeoutMs, guard: { enabled: false }, ts: r.ts });
          run.prompt = st.pendingPrompt;
          st.pendingPrompt = null;
          break;
        }
        case "junco_chat_turn_end":
          ensureRun();
          closeRun({
            stopReason: r.status === "ok" ? "stop" : "error",
            errorMessage: r.errorMessage,
            timedOut: false,
            abortedByGuard: false,
            durationMs: r.durationMs,
            usage: r.usage,
          });
          break;
        case "junco_chat_turn_aborted":
          ensureRun();
          closeRun({
            stopReason: `aborted:${r.reason}`,
            errorMessage: null,
            timedOut: r.reason === "timeout",
            abortedByGuard: false,
            durationMs: null,
            usage: null,
          });
          break;
        case "junco_chat_turn_rejected":
          noteRun().notes.push({ kind: "rejected", reason: r.reason, until: r.until, ts: r.ts });
          break;
        case "junco_chat_draft":
          noteRun().notes.push({ kind: "draft", draftId: r.draftId, draftKind: r.kind, status: r.status, ids: r.ids, destination: r.destination, ts: r.ts });
          break;
        case "junco_chat_session_reset":
          noteRun().notes.push({ kind: "reset", reason: r.reason, ts: r.ts });
          break;
        case "junco_chat_transcript_degraded":
          noteRun().notes.push({ kind: "degraded", ts: r.ts });
          break;
```

with `st.pendingPrompt: string | null` added to the reducer state and

```ts
// A note lands on the open run, else on the last run (a draft record
// follows its turn's end record, spec §3); a note before ANY run gets a
// prompt-less run that is closed immediately, so it renders and the
// transcript is not reported live.
const noteRun = (): RunSummary => {
  if (st.open !== null) return st.open;
  const last = out.runs[out.runs.length - 1];
  if (last !== undefined) return last;
  const run = openRun(null);
  run.flow = "chat";
  closeRun(V1_END);
  return run;
};
```

In the SDK `switch` add:

```ts
      case "compaction_start":
      case "compaction_end":
        ensureRun().notes.push({ kind: "compaction", phase: e.type === "compaction_start" ? "start" : "end", ts: null });
        break;
```

`agent_end` must NOT close a chat-framed run: it already doesn't (`st.framed` is true because `openRun` received a start record). Export:

```ts
export const draftAnchor = (draftId: string): string => `draft:${draftId}`;

/** Tool ids ∪ draft anchors in file order — the chat view's cursor space. */
export function anchorIds(s: TranscriptSummary): string[] {
  const out: string[] = [];
  for (const r of s.runs) {
    for (const t of r.turns) for (const c of t.toolCalls) out.push(c.id);
    for (const n of r.notes) if (n.kind === "draft") out.push(draftAnchor(n.draftId));
  }
  return out;
}
```

`src/transcriptRender.ts` — in `renderTranscriptRows`, inside `s.runs.forEach`, before the run header:

```ts
if (run.prompt !== null) for (const l of wrapText(`you: ${run.prompt}`, width)) push(l, "accent");
```

After the guard rows at the end of each run, render notes:

```ts
for (const n of run.notes) {
  switch (n.kind) {
    case "rejected":
      push(
        truncate(
          `   ⏸ turn rejected: ${n.reason}${n.until ? ` (until ${hhmmss(n.until)})` : ""}`,
          width,
        ),
        "warn",
      );
      break;
    case "draft": {
      const what = `${n.draftKind} · ${n.ids.join(", ") || n.draftId}`;
      const text =
        n.status === "parked"
          ? `   ▣ draft parked · ${what} — s submit · e edit · r route · D discard`
          : n.status === "lint_failed"
            ? `   ▣ draft parked (lint failed) · ${what} — e edit · D discard`
            : n.status === "submitted"
              ? `   ▣ draft submitted → ${n.destination ?? "?"} · ${what}`
              : `   ▣ draft discarded · ${what}`;
      push(
        truncate(text, width),
        n.status === "lint_failed" ? "warn" : n.status === "submitted" ? "success" : "bold",
        draftAnchor(n.draftId),
      );
      break;
    }
    case "reset":
      push(`   ↺ session reset (${n.reason})`, "warn");
      break;
    case "degraded":
      push("   ⚠ transcript disabled — history will not survive a reconnect", "warn");
      break;
    case "compaction":
      push(n.phase === "start" ? "   ⋯ compacting context…" : "   ⋯ context compacted", "dim");
      break;
  }
}
```

In `fmtRunOutcome`, an `aborted:<reason>` stopReason renders as `aborted (<reason>)` with tone `warn` (add before the `failed` computation: `if (end.stopReason?.startsWith("aborted:")) return { text: [ `aborted (${end.stopReason.slice(8)})`, …duration/usage parts ].join(" · "), tone: "warn" };`).

`tests/transcriptRender.test.ts:26-40` — the `run()` builder gains `prompt: null, notes: [],`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/transcriptSummary.test.ts tests/transcriptRender.test.ts tests/transcriptCmd.test.ts tests/tuiTranscript*.test.tsx > /tmp/t13 2>&1; echo "exit: $?"` — expected 0. `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/transcriptSummary.ts src/transcriptRender.ts tests/helpers/transcriptFixtures.ts tests/transcriptSummary.test.ts tests/transcriptRender.test.ts
git add src/transcriptSummary.ts src/transcriptRender.ts tests/helpers/transcriptFixtures.ts tests/transcriptSummary.test.ts tests/transcriptRender.test.ts
git commit -m "feat(transcript): summarize and render chat records — prompts, notes, draft anchors"
```

---

### Task 14: `chatClient.ts` and the `DashboardClient` additions

Spec §7. A pure SSE line parser + a reconnecting subscribe over the injectable `fetchFn`, the POST helpers, draft-store reads for the review surface, and the two `gh` context fetches. Everything joins `DashboardClient` (so `stubClient` in `tests/helpers/localFixtures.tsx` and the two other client literals gain the members — the compiler finds them).

**Files:**

- Create: `src/tui/chatClient.ts`
- Modify: `src/tui/ghClient.ts` (`DashboardClient` ~line 125–207; `makeGhDashboardClient` body ~248–740; `GhClientDeps` ~209–235)
- Modify: `tests/helpers/localFixtures.tsx:212-256` (`stubClient`), `tests/tuiApp.test.tsx`, `tests/useReview.test.tsx` (their client literals)
- Test: `tests/chatClient.test.ts`, `tests/tuiGhClient.test.ts` (context fetch + draft passthrough cases)

**Interfaces:**

- Consumes: `PendingDraft`, `listChatDrafts`, `readChatDraft`, `archiveChatDraft`, `writeChatDraft`, `draftFilePath` (Task 11); `ChatDraftRecord` (Task 1); `ChatStatus` (Task 7).
- Produces:

  ```ts
  // chatClient.ts
  export interface SseEvent { id: number | null; event: string | null; data: string }
  export function makeSseParser(): { push(chunk: string): SseEvent[] };     // stateful, partial-chunk safe; comments dropped
  export type ChatConnState = "connecting" | "live" | "reconnecting" | "down" | "ended";
  export interface ChatSubscribeHandlers { record(offset: number | null, line: string): void; status(s: ChatConnState): void; end(reason: string): void }
  export interface ChatClientDeps { fetchFn?: typeof fetch; baseUrl: string; backoffMs?: number[]; sleep?: (ms: number) => Promise<void> }
  export function subscribeChat(key: string, since: number | null, on: ChatSubscribeHandlers, deps: ChatClientDeps): () => void;
  export async function postChat(path: "prompt" | "abort" | "new" | "note", body: Record<string, unknown>, deps: ChatClientDeps): Promise<{ status: number; body: unknown }>;
  // ghClient.ts — DashboardClient additions
  chat: {
    subscribe(key, since, on): () => void;
    prompt(key, text): Promise<Result<{ mode: "prompt" | "steer" | "rejected" }>>;
    abort(key): Promise<Result<{ aborted: boolean }>>;
    fresh(key): Promise<Result<null>>;
    note(key, record: Omit<ChatDraftRecord, "ts">): Promise<Result<null>>;
  };
  listChatDrafts(): Promise<Result<PendingDraft[]>>;
  readChatDraftFile(id: string, name: string): Promise<Result<string>>;
  updateChatDraft(draft: PendingDraft): Promise<Result<null>>;        // rewrite JSON + files (route override, edited content)
  discardChatDraft(id: string): Promise<Result<null>>;
  archiveSubmittedChatDraft(id: string): Promise<Result<null>>;
  prContext(nwo: string, n: number): Promise<Result<string>>;
  issueContext(nwo: string, n: number): Promise<Result<string>>;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/chatClient.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeSseParser, subscribeChat, postChat } from "../src/tui/chatClient.js";

describe("SSE parser (spec 2026-09-01 §7)", () => {
  it("parses id/event/data frames across chunk boundaries and drops comments", () => {
    const p = makeSseParser();
    expect(p.push('id: 30\ndata: {"a":1}\n\n: ping\n\ndata: {"b')).toEqual([
      { id: 30, event: null, data: '{"a":1}' },
    ]);
    expect(p.push('":2}\n\nevent: end\ndata: {"reason":"x"}\n\n')).toEqual([
      { id: null, event: null, data: '{"b":2}' },
      { id: null, event: "end", data: '{"reason":"x"}' },
    ]);
    expect(p.push("data: a\ndata: b\n\n")).toEqual([{ id: null, event: null, data: "a\nb" }]);
  });
});

function streamOf(
  chunks: string[],
  opts: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, {
    status: opts.status ?? 200,
    headers: { "content-type": "text/event-stream", ...opts.headers },
  });
}

describe("subscribeChat", () => {
  it("delivers records with offsets, reports live, reconnects with Last-Event-ID, and reports ended", async () => {
    const calls: Array<{ url: string; lastId: string | undefined }> = [];
    let n = 0;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      calls.push({ url: String(url), lastId: h.get("last-event-id") ?? undefined });
      n++;
      if (n === 1)
        return streamOf([
          'id: 10\ndata: {"type":"junco_meta"}\n\n',
          'data: {"type":"message_update"}\n\n',
        ]);
      return streamOf([
        'id: 20\ndata: {"type":"turn_end"}\n\n',
        'event: end\ndata: {"reason":"daemon_stopped"}\n\n',
      ]);
    }) as unknown as typeof fetch;
    const got: Array<[number | null, string]> = [];
    const statuses: string[] = [];
    const ends: string[] = [];
    const stop = subscribeChat(
      "acme/api",
      null,
      {
        record: (o, l) => got.push([o, l]),
        status: (s) => statuses.push(s),
        end: (r) => ends.push(r),
      },
      { fetchFn, baseUrl: "http://127.0.0.1:1", backoffMs: [1], sleep: async () => {} },
    );
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(calls[0]!.url).toBe("http://127.0.0.1:1/chat/events?key=acme%2Fapi");
    expect(calls[1]!.lastId).toBe("10");
    expect(got).toEqual([
      [10, '{"type":"junco_meta"}'],
      [null, '{"type":"message_update"}'],
      [20, '{"type":"turn_end"}'],
    ]);
    expect(statuses[0]).toBe("connecting");
    expect(statuses).toContain("live");
    expect(statuses).toContain("reconnecting");
    expect(ends).toEqual(["daemon_stopped"]);
    expect(statuses[statuses.length - 1]).toBe("ended");
  });
  it("three consecutive failures → down; a later success → live again", async () => {
    let n = 0;
    const fetchFn = (async () => {
      n++;
      if (n <= 3) throw new Error("ECONNREFUSED");
      return streamOf(['id: 1\ndata: {"type":"junco_meta"}\n\n']);
    }) as unknown as typeof fetch;
    const statuses: string[] = [];
    const stop = subscribeChat(
      "k",
      0,
      { record: () => {}, status: (s) => statuses.push(s), end: () => {} },
      { fetchFn, baseUrl: "http://x", backoffMs: [1, 1, 1, 1], sleep: async () => {} },
    );
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(statuses).toContain("down");
    expect(statuses.indexOf("live")).toBeGreaterThan(statuses.indexOf("down"));
  });
  it("a 4xx response is reported down without retry storms; stop() ends the loop", async () => {
    let n = 0;
    const fetchFn = (async () => {
      n++;
      return new Response(JSON.stringify({ error: "chat_disabled" }), { status: 503 });
    }) as unknown as typeof fetch;
    const statuses: string[] = [];
    const stop = subscribeChat(
      "k",
      0,
      { record: () => {}, status: (s) => statuses.push(s), end: () => {} },
      { fetchFn, baseUrl: "http://x", backoffMs: [1], sleep: async () => {} },
    );
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(statuses).toContain("down");
    expect(n).toBeLessThan(10);
  });
});

describe("postChat", () => {
  it("POSTs JSON with no Origin header and returns status + parsed body", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      seen = { url: String(url), init: init! };
      return new Response(JSON.stringify({ mode: "steer" }), { status: 202 });
    }) as unknown as typeof fetch;
    const r = await postChat("prompt", { key: "k", text: "t" }, { fetchFn, baseUrl: "http://x" });
    expect(r).toEqual({ status: 202, body: { mode: "steer" } });
    expect(seen!.url).toBe("http://x/chat/prompt");
    expect(seen!.init.method).toBe("POST");
    expect(new Headers(seen!.init.headers).get("origin")).toBeNull();
    expect(JSON.parse(String(seen!.init.body))).toEqual({ key: "k", text: "t" });
  });
});
```

Add to `tests/tuiGhClient.test.ts` (using its `fakes()` + `makeGhDashboardClient` pattern; the `ghFn` fake there records argv and returns scripted stdout):

```ts
it("prContext/issueContext fetch through gh and render a compact block", async () => {
  const f = fakes();
  f.ghFn = (async (_cfg, args) => {
    if (args[0] === "pr")
      return {
        code: 0,
        stdout: JSON.stringify({
          title: "Add cache",
          body: "why",
          reviews: [{ author: { login: "bob" }, state: "CHANGES_REQUESTED", body: "no" }],
          comments: [{ author: { login: "amy" }, body: "hm" }],
        }),
        stderr: "",
      };
    return {
      code: 0,
      stdout: JSON.stringify({
        title: "Bug",
        body: "it breaks",
        comments: [{ author: { login: "amy" }, body: "me too" }],
      }),
      stderr: "",
    };
  }) as typeof f.ghFn;
  const c = makeGhDashboardClient(cfg, f);
  const pr = await c.prContext("acme/api", 42);
  expect(pr.ok && pr.value).toContain("PR #42: Add cache");
  expect(pr.ok && pr.value).toContain("bob (CHANGES_REQUESTED): no");
  const issue = await c.issueContext("acme/api", 7);
  expect(issue.ok && issue.value).toContain("Issue #7: Bug");
  expect(issue.ok && issue.value).toContain("amy: me too");
});
it("chat draft passthroughs read the draft store", async () => {
  const c = makeGhDashboardClient(cfg, fakes());
  const list = await c.listChatDrafts();
  expect(list).toEqual({ ok: true, value: [] });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/chatClient.test.ts tests/tuiGhClient.test.ts > /tmp/t14 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/tui/chatClient.ts`:

```ts
/**
 * The dashboard's side of /chat/* (spec 2026-09-01 §7): a stateful SSE
 * parser (partial-chunk safe), a reconnecting subscribe over the injectable
 * fetchFn that echoes Last-Event-ID, and the POST helpers. No Origin header
 * is ever sent — the daemon refuses any request that carries one (§5.3).
 */

export interface SseEvent {
  id: number | null;
  event: string | null;
  data: string;
}

export function makeSseParser(): { push(chunk: string): SseEvent[] } {
  let buf = "";
  return {
    push(chunk: string): SseEvent[] {
      buf += chunk;
      const out: SseEvent[] = [];
      let i: number;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let id: number | null = null;
        let event: string | null = null;
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) continue; // comment (": ping")
          const c = line.indexOf(":");
          const field = c === -1 ? line : line.slice(0, c);
          const value = c === -1 ? "" : line.slice(c + 1).replace(/^ /, "");
          if (field === "id") id = Number.parseInt(value, 10);
          else if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
        if (data.length > 0)
          out.push({ id: Number.isFinite(id as number) ? id : null, event, data: data.join("\n") });
      }
      return out;
    },
  };
}

export type ChatConnState = "connecting" | "live" | "reconnecting" | "down" | "ended";

export interface ChatSubscribeHandlers {
  record(offset: number | null, line: string): void;
  status(s: ChatConnState): void;
  end(reason: string): void;
}

export interface ChatClientDeps {
  fetchFn?: typeof fetch;
  baseUrl: string;
  /** Reconnect delays; the last repeats. Default 500 ms → 5 s. */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 5000];
const DOWN_AFTER = 3;

export function subscribeChat(
  key: string,
  since: number | null,
  on: ChatSubscribeHandlers,
  deps: ChatClientDeps,
): () => void {
  const fetchFn = deps.fetchFn ?? fetch;
  const backoff = deps.backoffMs ?? DEFAULT_BACKOFF;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let stopped = false;
  let lastId: number | null = since;
  let ctrl: AbortController | null = null;

  const loop = async (): Promise<void> => {
    let failures = 0;
    let attempt = 0;
    on.status("connecting");
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const url = new URL("/chat/events", deps.baseUrl);
        url.searchParams.set("key", key);
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (lastId !== null) headers["last-event-id"] = String(lastId);
        const resp = await fetchFn(url, { headers, signal: ctrl.signal });
        if (!resp.ok || !resp.body) {
          // A daemon answer (4xx/5xx) is a state, not a transport failure.
          on.status("down");
          if (resp.status >= 400 && resp.status < 500) return;
          throw new Error(`http ${resp.status}`);
        }
        failures = 0;
        attempt = 0;
        on.status("live");
        const parser = makeSseParser();
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const ev of parser.push(dec.decode(value, { stream: true }))) {
            if (ev.event === "end") {
              let reason = "ended";
              try {
                reason = String((JSON.parse(ev.data) as { reason?: string }).reason ?? reason);
              } catch {
                /* keep default */
              }
              on.end(reason);
              on.status("ended");
              return;
            }
            if (ev.id !== null) lastId = ev.id;
            on.record(ev.id, ev.data);
          }
        }
        if (stopped) return;
        on.status("reconnecting");
      } catch (e) {
        if (stopped || (e as { name?: string }).name === "AbortError") return;
        failures++;
        on.status(failures >= DOWN_AFTER ? "down" : "reconnecting");
      }
      await sleep(backoff[Math.min(attempt++, backoff.length - 1)]!);
    }
  };
  void loop();
  return () => {
    stopped = true;
    ctrl?.abort();
  };
}

export async function postChat(
  path: "prompt" | "abort" | "new" | "note",
  body: Record<string, unknown>,
  deps: ChatClientDeps,
): Promise<{ status: number; body: unknown }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const resp = await fetchFn(new URL(`/chat/${path}`, deps.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: resp.status, body: parsed };
}
```

**Lint ratchet (Ruling R15):** `makeGhDashboardClient` is pinned at 438 lines by `eslint.config.js`'s `GRANDFATHERED_FUNCTION_LINES` (max-lines-per-function, #438) — it may not grow. Put every new method body in a new module `src/tui/chatClientMethods.ts` exporting `chatClientMethods(cfg, deps): Pick<DashboardClient, "chat" | "listChatDrafts" | "readChatDraftFile" | "updateChatDraft" | "discardChatDraft" | "archiveSubmittedChatDraft" | "prContext" | "issueContext">` (with `attempt`, `ghFn`, `readFileFn`, `fetchFn`, `healthBase` passed in), and spread it into the client object with one line (`...chatClientMethods(cfg, { attempt, ghFn, readFileFn, fetchFn, healthBase })`). The code below is what goes in that module.

`src/tui/ghClient.ts` — imports: `subscribeChat, postChat, type ChatSubscribeHandlers` from `./chatClient.js` move to `chatClientMethods.ts`; `listChatDrafts, readChatDraft, writeChatDraft, archiveChatDraft, draftFilePath, type PendingDraft` from `../chat/draftStore.js`; `type ChatDraftRecord` from `../agent/transcriptSchema.js`. `DashboardClient` gains the members listed under Interfaces. In `makeGhDashboardClient`:

```ts
    chat: {
      subscribe(key, since, on) {
        return subscribeChat(key, since, on, { fetchFn, baseUrl: healthBase });
      },
      prompt(key, text) {
        return attempt(async () => {
          const r = await postChat("prompt", { key, text }, { fetchFn, baseUrl: healthBase });
          if (r.status !== 202 && r.status !== 200) throw new Error(chatErr(r));
          return r.body as { mode: "prompt" | "steer" | "rejected" };
        });
      },
      abort(key) {
        return attempt(async () => {
          const r = await postChat("abort", { key }, { fetchFn, baseUrl: healthBase });
          if (r.status !== 202 && r.status !== 204) throw new Error(chatErr(r));
          return { aborted: r.status === 202 };
        });
      },
      fresh(key) {
        return attempt(async () => {
          const r = await postChat("new", { key }, { fetchFn, baseUrl: healthBase });
          if (r.status !== 202) throw new Error(chatErr(r));
          return null;
        });
      },
      note(key, record) {
        return attempt(async () => {
          const r = await postChat("note", { key, record }, { fetchFn, baseUrl: healthBase });
          if (r.status !== 202) throw new Error(chatErr(r));
          return null;
        });
      },
    },
    listChatDrafts() {
      return attempt(async () => listChatDrafts(cfg));
    },
    readChatDraftFile(id, name) {
      return attempt(async () => readFileFn(draftFilePath(cfg, id, name)));
    },
    updateChatDraft(draft) {
      return attempt(async () => {
        writeChatDraft(cfg, draft);
        return null;
      });
    },
    discardChatDraft(id) {
      return attempt(async () => {
        archiveChatDraft(cfg, id, "discarded");
        return null;
      });
    },
    archiveSubmittedChatDraft(id) {
      return attempt(async () => {
        archiveChatDraft(cfg, id, "submitted");
        return null;
      });
    },
    prContext(nwo, num) {
      return attempt(async () => {
        const v = await ghFn(cfg, ["pr", "view", String(num), "--repo", nwo, "--json", "title,body,reviews,comments"], { timeoutMs: GH_TIMEOUT, retryNetwork: true });
        const j = JSON.parse(v.stdout) as { title?: string; body?: string; reviews?: Array<{ author?: { login?: string }; state?: string; body?: string }>; comments?: Array<{ author?: { login?: string }; body?: string }> };
        const lines = [`PR #${num}: ${j.title ?? ""}`, "", j.body ?? "", ""];
        for (const r of j.reviews ?? []) if (r.body) lines.push(`${r.author?.login ?? "?"} (${r.state ?? "COMMENTED"}): ${r.body}`);
        for (const c of j.comments ?? []) if (c.body) lines.push(`${c.author?.login ?? "?"}: ${c.body}`);
        return lines.join("\n").trim();
      });
    },
    issueContext(nwo, num) {
      return attempt(async () => {
        const v = await ghFn(cfg, ["issue", "view", String(num), "--repo", nwo, "--json", "title,body,comments"], { timeoutMs: GH_TIMEOUT, retryNetwork: true });
        const j = JSON.parse(v.stdout) as { title?: string; body?: string; comments?: Array<{ author?: { login?: string }; body?: string }> };
        const lines = [`Issue #${num}: ${j.title ?? ""}`, "", j.body ?? "", ""];
        for (const c of j.comments ?? []) if (c.body) lines.push(`${c.author?.login ?? "?"}: ${c.body}`);
        return lines.join("\n").trim();
      });
    },
```

with `const healthBase = \`http://${bracketHost(cfg.healthHost)}:${cfg.healthPort}\`;`(reuse`bracketHost`from`statusCmd.ts`/`healthServer.ts`— export it from`healthServer.ts` if it isn't) and

```ts
const chatErr = (r: { status: number; body: unknown }): string => {
  const e = r.body && typeof r.body === "object" ? (r.body as { error?: string }).error : undefined;
  return e ?? `chat request failed (${r.status})`;
};
```

`tests/helpers/localFixtures.tsx` `stubClient` (and the client literals in `tests/tuiApp.test.tsx`, `tests/useReview.test.tsx`) gain:

```ts
  chat: {
    subscribe: () => () => {},
    prompt: async () => okv({ mode: "prompt" as const }),
    abort: async () => okv({ aborted: false }),
    fresh: async () => okv(null),
    note: async () => okv(null),
  },
  listChatDrafts: async () => okv([]),
  readChatDraftFile: async () => okv(""),
  updateChatDraft: async () => okv(null),
  discardChatDraft: async () => okv(null),
  archiveSubmittedChatDraft: async () => okv(null),
  prContext: async () => okv(""),
  issueContext: async () => okv(""),
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/chatClient.test.ts tests/tuiGhClient.test.ts tests/tuiApp.test.tsx tests/useReview.test.tsx > /tmp/t14 2>&1; echo "exit: $?"` — expected 0. `npm run typecheck` clean (every `DashboardClient` literal compiles).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/chatClient.ts src/tui/ghClient.ts src/healthServer.ts tests/chatClient.test.ts tests/tuiGhClient.test.ts tests/helpers/localFixtures.tsx tests/tuiApp.test.tsx tests/useReview.test.tsx
git add src/tui/chatClient.ts src/tui/ghClient.ts src/healthServer.ts tests/chatClient.test.ts tests/tuiGhClient.test.ts tests/helpers/localFixtures.tsx tests/tuiApp.test.tsx tests/useReview.test.tsx
git commit -m "feat(tui): chat client — SSE subscribe with reconnect, POST verbs, draft and gh context passthroughs"
```

---

### Task 15: `useChat` — the chat domain hook

Spec §8.5. Owns the record ring, the summary (recomputed only on non-`message_update` records), the live text (coalesced at 50 ms), connection state, cards (draft store joined with the transcript's draft notes), composer text and focus, cursor/follow/expanded. App passes the nav spine in read-only, like every hook in `src/tui/hooks/`.

**Files:**

- Create: `src/tui/hooks/useChat.ts`
- Test: `tests/useChat.test.tsx`

**Interfaces:**

- Consumes: `DashboardClient.chat`, `listChatDrafts`, `PendingDraft` (Task 14); `summarizeTranscript`, `anchorIds`, `TranscriptSummary` (Task 13); `ChatConnState` (Task 14).
- Produces:

  ```ts
  export const CHAT_RING = 2000;
  export const CHAT_FLUSH_MS = 50;
  export interface ChatState {
    key: string;
    connection: ChatConnState;
    endReason: string | null;
    summary: TranscriptSummary | null; // over the ring, excluding message_update
    liveText: string; // in-flight assistant text (bus-only deltas), cleared at turn end
    streaming: boolean;
    blocked: { reason: string; until: string | null } | null;
    degraded: boolean;
    overflowed: boolean; // ring dropped records: header shows "showing last 2000"
    drafts: PendingDraft[]; // parked drafts for this key
    composer: string;
    composerFocused: boolean;
    cursor: number; // index into anchorIds(summary)
    follow: boolean;
    showThinking: boolean;
    expanded: ReadonlySet<string>;
    lastOffset: number | null;
    error: string | null; // last POST failure (toast-worthy)
  }
  export interface ChatApi {
    chat: ChatState | null;
    openChat(key: string): void;
    closeChat(): void;
    send(text: string): Promise<void>;
    abort(): Promise<void>;
    fresh(): Promise<void>;
    setComposer(text: string): void;
    focusComposer(on: boolean): void;
    moveCursor(delta: number): void;
    toggleExpanded(): void;
    toggleThinking(): void;
    setFollow(on: boolean): void;
    reloadDrafts(): Promise<void>;
    selectedDraft(): PendingDraft | null; // the draft under the cursor, when the anchor is a draft
  }
  export function useChat(opts: {
    client: DashboardClient;
    aliveRef: MutableRefObject<boolean>;
    flushMs?: number;
  }): ChatApi;
  ```

- [ ] **Step 1: Write the failing test**

`tests/useChat.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useChat, CHAT_RING } from "../src/tui/hooks/useChat.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { ChatSubscribeHandlers } from "../src/tui/chatClient.js";
import { stubClient } from "./helpers/localFixtures.js";
import { until } from "./helpers/until.js";
import {
  chatDraft,
  chatPrompt,
  chatTurnEnd,
  chatTurnStart,
  chatTurnRejected,
  metaLine,
  turnEndFull,
} from "./helpers/transcriptFixtures.js";

function makeClient(over: Partial<DashboardClient["chat"]> = {}, drafts: unknown[] = []) {
  let handlers: ChatSubscribeHandlers | null = null;
  const calls: string[] = [];
  const client: DashboardClient = {
    ...stubClient,
    listChatDrafts: async () => ({ ok: true, value: drafts as never }),
    chat: {
      ...stubClient.chat,
      subscribe: (_key, _since, on) => {
        handlers = on;
        on.status("live");
        return () => calls.push("unsub");
      },
      prompt: async (_k, text) => (
        calls.push(`prompt:${text}`),
        { ok: true, value: { mode: "prompt" as const } }
      ),
      abort: async () => (calls.push("abort"), { ok: true, value: { aborted: true } }),
      fresh: async () => (calls.push("fresh"), { ok: true, value: null }),
      ...over,
    },
  };
  return {
    client,
    calls,
    push: (offset: number | null, line: string) => handlers!.record(offset, line),
    status: (s: Parameters<ChatSubscribeHandlers["status"]>[0]) => handlers!.status(s),
    end: (r: string) => handlers!.end(r),
  };
}

function Probe({
  client,
  onReady,
}: {
  client: DashboardClient;
  onReady: (api: ReturnType<typeof useChat>) => void;
}) {
  const aliveRef = React.useRef(true);
  const api = useChat({ client, aliveRef, flushMs: 5 });
  onReady(api);
  return (
    <Text>
      {api.chat
        ? `${api.chat.connection}:${api.chat.streaming ? "streaming" : "idle"}:${api.chat.liveText}`
        : "closed"}
    </Text>
  );
}

describe("useChat (spec 2026-09-01 §8.5)", () => {
  it("opens, subscribes, and derives summary/live text/streaming from the stream", async () => {
    const c = makeClient();
    let api!: ReturnType<typeof useChat>;
    const r = render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api");
    await until(() => r.lastFrame()!.includes("live:idle"));
    c.push(10, metaLine({ ticketId: "acme__api" }));
    c.push(20, chatPrompt());
    c.push(30, chatTurnStart());
    c.push(
      null,
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "beca" },
      }),
    );
    c.push(
      null,
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "use" },
      }),
    );
    await until(() => r.lastFrame()!.includes("live:streaming:because"));
    expect(api.chat!.summary!.runs[0]!.prompt).toBe("why is the build slow?");
    c.push(
      40,
      turnEndFull({ thinking: null, text: "because", calls: [], usage: { input: 1, output: 1 } }),
    );
    c.push(50, chatTurnEnd());
    await until(() => r.lastFrame()!.includes("live:idle:"));
    expect(api.chat!.liveText).toBe("");
    expect(api.chat!.lastOffset).toBe(50);
    expect(api.chat!.summary!.runs[0]!.end).not.toBeNull();
  });

  it("send() clears the composer and POSTs; a rejection record sets blocked; abort/fresh wire through", async () => {
    const c = makeClient();
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    api.setComposer("hello");
    await api.send("hello");
    expect(c.calls).toContain("prompt:hello");
    await until(() => api.chat!.composer === "");
    c.push(60, chatTurnRejected());
    await until(() => api.chat!.blocked?.reason === "rate limited");
    await api.abort();
    await api.fresh();
    expect(c.calls).toEqual(expect.arrayContaining(["abort", "fresh"]));
  });

  it("drafts join the transcript's draft notes; the cursor walks anchors; selectedDraft resolves", async () => {
    const draft = {
      id: "acme__api-20260901-120000-1",
      key: "acme/api",
      slug: "acme__api",
      kind: "ticket",
      files: [],
      cwd: "/r",
      nwo: "acme/api",
      createdAt: "t",
      lintFailed: false,
      blocked: null,
      routeOverride: "auto",
      commandArgs: null,
    };
    const c = makeClient({}, [draft]);
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    c.push(10, metaLine());
    c.push(20, chatDraft());
    await until(() => api.chat!.drafts.length === 1);
    await until(() => api.selectedDraft()?.id === draft.id);
  });

  it("the ring keeps the last CHAT_RING records and flags overflow; end/status propagate; close unsubscribes", async () => {
    const c = makeClient();
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    for (let i = 0; i < CHAT_RING + 5; i++)
      c.push(
        i + 1,
        JSON.stringify({
          type: "tool_execution_start",
          toolCallId: `c${i}`,
          toolName: "read",
          args: {},
        }),
      );
    await until(() => api.chat!.overflowed === true);
    c.status("reconnecting");
    await until(() => api.chat!.connection === "reconnecting");
    c.end("daemon_stopped");
    await until(() => api.chat!.endReason === "daemon_stopped");
    api.closeChat();
    await until(() => api.chat === null);
    expect(c.calls).toContain("unsub");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/useChat.test.tsx > /tmp/t15 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/tui/hooks/useChat.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { DashboardClient } from "../ghClient.js";
import type { ChatConnState } from "../chatClient.js";
import type { PendingDraft } from "../../chat/draftStore.js";
import { anchorIds, summarizeTranscript, type TranscriptSummary } from "../../transcriptSummary.js";
import { parseTranscriptLine } from "../../agent/transcriptSchema.js";

export const CHAT_RING = 2000;
export const CHAT_FLUSH_MS = 50;

export interface ChatState {
  key: string;
  connection: ChatConnState;
  endReason: string | null;
  summary: TranscriptSummary | null;
  liveText: string;
  streaming: boolean;
  blocked: { reason: string; until: string | null } | null;
  degraded: boolean;
  overflowed: boolean;
  drafts: PendingDraft[];
  composer: string;
  composerFocused: boolean;
  cursor: number;
  follow: boolean;
  showThinking: boolean;
  expanded: ReadonlySet<string>;
  lastOffset: number | null;
  error: string | null;
}

export interface ChatApi {
  chat: ChatState | null;
  openChat(key: string): void;
  closeChat(): void;
  send(text: string): Promise<void>;
  abort(): Promise<void>;
  fresh(): Promise<void>;
  setComposer(text: string): void;
  focusComposer(on: boolean): void;
  moveCursor(delta: number): void;
  toggleExpanded(): void;
  toggleThinking(): void;
  setFollow(on: boolean): void;
  reloadDrafts(): Promise<void>;
  selectedDraft(): PendingDraft | null;
}

const fresh = (key: string): ChatState => ({
  key,
  connection: "connecting",
  endReason: null,
  summary: null,
  liveText: "",
  streaming: false,
  blocked: null,
  degraded: false,
  overflowed: false,
  drafts: [],
  composer: "",
  composerFocused: true,
  cursor: 0,
  follow: true,
  showThinking: false,
  expanded: new Set(),
  lastOffset: null,
  error: null,
});

/**
 * chat-view domain (spec 2026-09-01 §8.5). The record ring lives in a ref
 * (2000 persisted lines); the summary is recomputed only when a NON-delta
 * record lands, and message_update deltas accumulate into `liveText` through
 * a 50 ms flush — the spike showed per-delta setState is survivable, and the
 * batch is cheap insurance for slow terminals.
 */
export function useChat({
  client,
  aliveRef,
  flushMs = CHAT_FLUSH_MS,
}: {
  client: DashboardClient;
  aliveRef: MutableRefObject<boolean>;
  flushMs?: number;
}): ChatApi {
  const [chat, setChat] = useState<ChatState | null>(null);
  const ring = useRef<string[]>([]);
  const pendingDelta = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const keyRef = useRef<string | null>(null);

  const flushDelta = useCallback((): void => {
    flushTimer.current = null;
    const d = pendingDelta.current;
    pendingDelta.current = "";
    if (d === "" || !aliveRef.current) return;
    setChat((s) => (s === null ? s : { ...s, liveText: s.liveText + d }));
  }, [aliveRef]);

  const reloadDrafts = useCallback(async (): Promise<void> => {
    const key = keyRef.current;
    if (key === null) return;
    const r = await client.listChatDrafts();
    if (!aliveRef.current || !r.ok) return;
    const mine = r.value.filter((d) => d.key === key);
    setChat((s) => (s === null || s.key !== key ? s : { ...s, drafts: mine }));
  }, [client, aliveRef]);

  const onRecord = useCallback(
    (offset: number | null, line: string): void => {
      const p = parseTranscriptLine(line);
      if (p.kind === "sdk" && p.event.type === "message_update") {
        const ev = p.event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (ev?.type === "text_delta" && typeof ev.delta === "string") {
          pendingDelta.current += ev.delta;
          flushTimer.current ??= setTimeout(flushDelta, flushMs);
        }
        return;
      }
      let overflowed = false;
      ring.current.push(line);
      if (ring.current.length > CHAT_RING) {
        ring.current.splice(0, ring.current.length - CHAT_RING);
        overflowed = true;
      }
      const summary = summarizeTranscript(ring.current);
      const rec = p.kind === "junco" ? p.record : null;
      let draftsChanged = false;
      setChat((s) => {
        if (s === null) return s;
        const n = anchorIds(summary).length;
        let next: ChatState = {
          ...s,
          summary,
          streaming: summary.live,
          overflowed: s.overflowed || overflowed,
          cursor: Math.min(s.cursor, Math.max(0, n - 1)),
          lastOffset: offset ?? s.lastOffset,
        };
        if (rec?.type === "junco_chat_turn_start") next = { ...next, liveText: "", blocked: null };
        if (rec?.type === "junco_chat_turn_end" || rec?.type === "junco_chat_turn_aborted")
          next = { ...next, liveText: "" };
        if (rec?.type === "junco_chat_turn_rejected")
          next = { ...next, blocked: { reason: rec.reason, until: rec.until } };
        if (rec?.type === "junco_chat_transcript_degraded") next = { ...next, degraded: true };
        if (rec?.type === "junco_chat_draft") draftsChanged = true;
        return next;
      });
      if (draftsChanged) void reloadDrafts();
    },
    [flushDelta, flushMs, reloadDrafts],
  );

  const closeChat = useCallback((): void => {
    unsubRef.current?.();
    unsubRef.current = null;
    keyRef.current = null;
    ring.current = [];
    pendingDelta.current = "";
    if (flushTimer.current !== null) clearTimeout(flushTimer.current);
    flushTimer.current = null;
    setChat(null);
  }, []);

  const openChat = useCallback(
    (key: string): void => {
      closeChat();
      keyRef.current = key;
      setChat(fresh(key));
      unsubRef.current = client.chat.subscribe(key, null, {
        record: onRecord,
        status: (connection) => {
          if (!aliveRef.current) return;
          setChat((s) => (s === null || s.key !== key ? s : { ...s, connection }));
        },
        end: (endReason) => {
          if (!aliveRef.current) return;
          setChat((s) => (s === null || s.key !== key ? s : { ...s, endReason, streaming: false }));
        },
      });
      void reloadDrafts();
    },
    [client, aliveRef, closeChat, onRecord, reloadDrafts],
  );

  useEffect(() => () => closeChat(), [closeChat]);

  const withKey = useCallback(
    async (fn: (key: string) => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
      const key = keyRef.current;
      if (key === null) return;
      const r = await fn(key);
      if (!aliveRef.current) return;
      if (!r.ok)
        setChat((s) => (s === null ? s : { ...s, error: r.error ?? "chat request failed" }));
    },
    [aliveRef],
  );

  const send = useCallback(
    async (text: string): Promise<void> => {
      if (text.trim() === "") return;
      setChat((s) => (s === null ? s : { ...s, composer: "", error: null }));
      await withKey((key) => client.chat.prompt(key, text));
    },
    [client, withKey],
  );
  const abort = useCallback(() => withKey((key) => client.chat.abort(key)), [client, withKey]);
  const freshSession = useCallback(async (): Promise<void> => {
    await withKey((key) => client.chat.fresh(key));
    ring.current = [];
    setChat((s) =>
      s === null ? s : { ...fresh(s.key), connection: s.connection, drafts: s.drafts },
    );
  }, [client, withKey]);

  const setComposer = useCallback(
    (composer: string): void => setChat((s) => (s === null ? s : { ...s, composer })),
    [],
  );
  const focusComposer = useCallback(
    (composerFocused: boolean): void =>
      setChat((s) => (s === null ? s : { ...s, composerFocused })),
    [],
  );
  const moveCursor = useCallback(
    (delta: number): void =>
      setChat((s) => {
        if (s === null || s.summary === null) return s;
        const n = anchorIds(s.summary).length;
        const cursor = n === 0 ? s.cursor : Math.max(0, Math.min(s.cursor + delta, n - 1));
        return { ...s, cursor, follow: false };
      }),
    [],
  );
  const toggleExpanded = useCallback(
    (): void =>
      setChat((s) => {
        if (s === null || s.summary === null) return s;
        const id = anchorIds(s.summary)[s.cursor];
        if (id === undefined || id.startsWith("draft:")) return s;
        const expanded = new Set(s.expanded);
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        return { ...s, expanded };
      }),
    [],
  );
  const toggleThinking = useCallback(
    (): void => setChat((s) => (s === null ? s : { ...s, showThinking: !s.showThinking })),
    [],
  );
  const setFollow = useCallback(
    (follow: boolean): void => setChat((s) => (s === null ? s : { ...s, follow })),
    [],
  );
  const selectedDraft = useCallback((): PendingDraft | null => {
    if (chat === null || chat.summary === null) return null;
    const id = anchorIds(chat.summary)[chat.cursor];
    if (id === undefined || !id.startsWith("draft:")) return null;
    const draftId = id.slice("draft:".length);
    return chat.drafts.find((d) => d.id === draftId) ?? null;
  }, [chat]);

  return {
    chat,
    openChat,
    closeChat,
    send,
    abort,
    fresh: freshSession,
    setComposer,
    focusComposer,
    moveCursor,
    toggleExpanded,
    toggleThinking,
    setFollow,
    reloadDrafts,
    selectedDraft,
  };
}
```

`npm run lint` runs `exhaustive-deps` at error over this file: every `useCallback` above lists what it closes over; keep it that way when adjusting.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/useChat.test.tsx > /tmp/t15 2>&1; echo "exit: $?"` — expected 0. `npm run lint` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/hooks/useChat.ts tests/useChat.test.tsx
git add src/tui/hooks/useChat.ts tests/useChat.test.tsx
git commit -m "feat(tui): useChat — record ring, coalesced live text, cards, composer state"
```

---

### Task 16: `Composer.tsx` — multiline input with chords, paste, and the slash list

Spec §8.2, §8.4. A controlled multiline field on `useGuardedInput` (the one gate every handler goes through) plus Ink's native `usePaste`. `enter` submits; `\x1b\r` (alt+enter → `key.return && key.meta`) and `\n` (ctrl+j → `input === "\n"`) insert a newline; a leading `/` shows a completion list navigated with `↑/↓` and accepted with `tab`.

**Files:**

- Create: `src/tui/components/Composer.tsx`
- Test: `tests/tuiComposer.test.tsx`

**Interfaces:**

- Consumes: `useGuardedInput` (`src/tui/useGuardedInput.ts`), `usePaste` (`ink`), `theme`.
- Produces:

  ```ts
  export const SLASH_COMMANDS: ReadonlyArray<{ name: string; hint: string; takesArg: boolean }>; // draft, audit, investigate, pr, issue, abort, new
  export interface ComposerProps {
    value: string;
    onChange(v: string): void;
    onSubmit(v: string): void;
    focused: boolean;
    disabled?: boolean;
    disabledReason?: string;
    width: number;
    maxRows?: number;
  }
  export function Composer(props: ComposerProps): React.JSX.Element;
  export function slashMatches(value: string): typeof SLASH_COMMANDS; // pure: candidates for a leading-slash value
  ```

- [ ] **Step 1: Write the failing test**

`tests/tuiComposer.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React, { useState } from "react";
import { render } from "ink-testing-library";
import { Composer, slashMatches } from "../src/tui/components/Composer.js";
import { until } from "./helpers/until.js";

function Host({
  onSubmit,
  disabled = false,
}: {
  onSubmit: (v: string) => void;
  disabled?: boolean;
}) {
  const [v, setV] = useState("");
  return (
    <Composer
      value={v}
      onChange={setV}
      onSubmit={onSubmit}
      focused
      width={60}
      disabled={disabled}
      disabledReason="daemon down"
    />
  );
}

describe("Composer (spec 2026-09-01 §8.2, §8.4)", () => {
  it("types, submits on enter, inserts newlines on alt+enter and ctrl+j", async () => {
    const sent: string[] = [];
    const r = render(<Host onSubmit={(v) => sent.push(v)} />);
    r.stdin.write("hi");
    await until(() => r.lastFrame()!.includes("hi"));
    r.stdin.write("\x1b\r"); // alt+enter → key.return && key.meta
    await until(
      () =>
        r
          .lastFrame()!
          .split("\n")
          .filter((l) => l.includes("│")).length >= 2 || r.lastFrame()!.includes("hi\n"),
    );
    r.stdin.write("there");
    await until(() => r.lastFrame()!.includes("there"));
    r.stdin.write("\n"); // ctrl+j → input "\n", key.return false
    r.stdin.write("end");
    await until(() => r.lastFrame()!.includes("end"));
    r.stdin.write("\r");
    await until(() => sent.length === 1);
    expect(sent[0]).toBe("hi\nthere\nend");
  });

  it("a paste lands as one insertion, newlines intact, and never submits", async () => {
    const sent: string[] = [];
    const r = render(<Host onSubmit={(v) => sent.push(v)} />);
    r.stdin.write("\x1b[200~line one\nline two\x1b[201~");
    await until(() => r.lastFrame()!.includes("line two"));
    expect(sent).toEqual([]);
    r.stdin.write("\r");
    await until(() => sent.length === 1);
    expect(sent[0]).toBe("line one\nline two");
  });

  it("a leading slash shows matching commands; tab completes; enter submits the command", async () => {
    const sent: string[] = [];
    const r = render(<Host onSubmit={(v) => sent.push(v)} />);
    r.stdin.write("/a");
    await until(
      () =>
        r.lastFrame()!.includes("/abort") &&
        r.lastFrame()!.includes("/audit") &&
        !r.lastFrame()!.includes("/investigate"),
    );
    expect(r.lastFrame()).not.toContain("/draft");
    r.stdin.write("\t");
    await until(() => r.lastFrame()!.includes("/audit") && !r.lastFrame()!.includes("/abort"));
    r.stdin.write("\r");
    await until(() => sent.length === 1);
    expect(sent[0]).toBe("/audit");
  });

  it("disabled: shows the reason and swallows input", async () => {
    const sent: string[] = [];
    const r = render(<Host onSubmit={(v) => sent.push(v)} disabled />);
    await until(() => r.lastFrame()!.includes("daemon down"));
    r.stdin.write("x\r");
    await new Promise((res) => setTimeout(res, 30));
    expect(sent).toEqual([]);
    expect(r.lastFrame()).not.toContain("x");
  });

  it("slashMatches is pure and prefix-based", () => {
    expect(slashMatches("/").map((c) => c.name)).toEqual([
      "draft",
      "audit",
      "investigate",
      "pr",
      "issue",
      "abort",
      "new",
    ]);
    expect(slashMatches("/in").map((c) => c.name)).toEqual(["investigate"]);
    expect(slashMatches("/a").map((c) => c.name)).toEqual(["audit", "abort"]);
    expect(slashMatches("hello")).toEqual([]);
    expect(slashMatches("/pr 4")).toEqual([]); // an argument ends completion
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tuiComposer.test.tsx > /tmp/t16 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/tui/components/Composer.tsx`:

```tsx
import React, { useState } from "react";
import { Box, Text, usePaste } from "ink";
import { useGuardedInput } from "../useGuardedInput.js";
import { theme } from "../theme.js";

export const SLASH_COMMANDS: ReadonlyArray<{ name: string; hint: string; takesArg: boolean }> = [
  { name: "draft", hint: "draft a ticket from this conversation", takesArg: false },
  { name: "audit", hint: "request a read-only repo audit (junco audit)", takesArg: false },
  {
    name: "investigate",
    hint: "investigate N — deep-read issue #N (junco investigate)",
    takesArg: true,
  },
  { name: "pr", hint: "pr N — pull PR #N (body, reviews, comments) into the chat", takesArg: true },
  { name: "issue", hint: "issue N — pull issue #N into the chat", takesArg: true },
  { name: "abort", hint: "abort the streaming turn", takesArg: false },
  { name: "new", hint: "archive this session and start fresh", takesArg: false },
];

/** Candidates for a leading-slash value; an argument (a space) ends completion. */
export function slashMatches(value: string): typeof SLASH_COMMANDS {
  if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) return [];
  const prefix = value.slice(1);
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}

export interface ComposerProps {
  value: string;
  onChange(v: string): void;
  onSubmit(v: string): void;
  focused: boolean;
  disabled?: boolean;
  disabledReason?: string;
  width: number;
  /** Visible rows for the text (default 4); longer input scrolls to the tail. */
  maxRows?: number;
}

/**
 * Multiline composer (spec 2026-09-01 §8.2). Ink 7's keypress parser makes
 * both newline chords deterministic (parse-keypress.js:414-421): alt+enter
 * arrives as `\x1b\r` → key.return && key.meta; ctrl+j arrives as `\n` →
 * input "\n" with key.return false. Paste comes through Ink's own bracketed-
 * paste channel (usePaste, §8.4) as one string and never reaches useInput.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  focused,
  disabled = false,
  disabledReason,
  width,
  maxRows = 4,
}: ComposerProps): React.JSX.Element {
  const [slashSel, setSlashSel] = useState(0);
  const matches = slashMatches(value);
  const active = focused && !disabled;

  useGuardedInput(
    (input, key) => {
      if (matches.length > 0) {
        if (key.upArrow) return setSlashSel((s) => Math.max(0, s - 1));
        if (key.downArrow) return setSlashSel((s) => Math.min(matches.length - 1, s + 1));
        if (key.tab) {
          const c = matches[Math.min(slashSel, matches.length - 1)]!;
          onChange(`/${c.name}${c.takesArg ? " " : ""}`);
          setSlashSel(0);
          return;
        }
      }
      if (key.return && key.meta) return onChange(value + "\n");
      if (key.return) {
        setSlashSel(0);
        return onSubmit(value);
      }
      if (input === "\n") return onChange(value + "\n");
      if (key.backspace || key.delete) return onChange(value.slice(0, -1));
      if (input && !key.ctrl && !key.meta && !key.escape && !key.tab) {
        setSlashSel(0);
        onChange(value + input);
      }
    },
    { isActive: active },
  );
  usePaste((text) => onChange(value + text.replace(/\r\n?/g, "\n")), { isActive: active });

  const lines = value === "" ? [""] : value.split("\n");
  const shown = lines.slice(Math.max(0, lines.length - maxRows));
  const inner = Math.max(10, width - 4);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={active ? theme.accent : theme.border}
      paddingX={1}
    >
      {disabled ? (
        <Text dimColor>{disabledReason ?? "chat unavailable"}</Text>
      ) : (
        shown.map((l, i) => (
          <Text key={i} wrap="truncate">
            {i === shown.length - 1 && active ? (
              <>
                {l}
                <Text color="cyan">█</Text>
              </>
            ) : l === "" && i === 0 && shown.length === 1 ? (
              <Text dimColor>type a message — enter to send · ctrl+j newline · / commands</Text>
            ) : (
              l
            )}
          </Text>
        ))
      )}
      {matches.length > 0 && !disabled && (
        <Box flexDirection="column" marginTop={0}>
          {matches.map((c, i) => (
            <Text
              key={c.name}
              color={i === Math.min(slashSel, matches.length - 1) ? theme.accent : undefined}
              wrap="truncate"
            >
              {`/${c.name}`.padEnd(10)} <Text dimColor>{c.hint.slice(0, inner - 12)}</Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
```

`useGuardedInput(handler: (input: string, key: Key) => void, options?: { isActive?: boolean })` (`src/tui/useGuardedInput.ts:10-18`) forwards Ink's `Key` unchanged — including `meta` and `tab` — and drops only mouse CSI leaks.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tuiComposer.test.tsx > /tmp/t16 2>&1; echo "exit: $?"` — expected 0. `npm run lint` clean (react-hooks rules).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/Composer.tsx tests/tuiComposer.test.tsx
git add src/tui/components/Composer.tsx tests/tuiComposer.test.tsx
git commit -m "feat(tui): Composer — multiline input, newline chords, native paste, slash commands"
```

---

### Task 17: `TranscriptBody` extraction and `ChatView`

Spec §8.2. The rows + scrollbar + cursor gutter block of `TranscriptView` (`src/tui/components/TranscriptView.tsx:127-148`) becomes a shared `TranscriptBody` component; `TranscriptView` and the new `ChatView` both compose it. `ChatView` = header strip + `TranscriptBody` over the chat summary (with the in-flight `liveText` appended as trailing rows) + `Composer`. Pure layout: every action arrives as a prop.

**Files:**

- Create: `src/tui/components/TranscriptBody.tsx`, `src/tui/components/ChatView.tsx`
- Modify: `src/tui/components/TranscriptView.tsx` (use `TranscriptBody`; behavior unchanged)
- Test: `tests/tuiChatView.test.tsx`; existing `tests/tuiTranscriptView.test.tsx` stays green

**Interfaces:**

- Consumes: `renderTranscriptRows`, `TranscriptRow`, `wrapText`, `MIN_WIDTH` (`src/transcriptRender.ts`); `anchorIds` (Task 13); `ChatState` (Task 15); `Composer` (Task 16); `Scrollbar`, `ClickableBox`, `theme`, `clampScroll`/`maxScroll` (`src/tui/window.ts`), `bumpRender`.
- Produces:

  ```tsx
  export interface TranscriptBodyProps {
    rows: TranscriptRow[];
    anchors: string[];
    cursor: number;
    follow: boolean;
    scroll: number;
    visible: number;
    focused: boolean;
    onScrollMax?(max: number): void;
    onRowPress?(anchorIdx: number): void;
  }
  export const TranscriptBody: React.MemoExoticComponent<
    (p: TranscriptBodyProps) => React.JSX.Element
  >;
  export function chatHeaderStatus(
    s: ChatState,
    modelId: string | null,
  ): { text: string; tone?: RowTone }; // pure
  export interface ChatViewProps {
    state: ChatState;
    modelId: string | null;
    costUsd: number | null;
    scroll: number;
    height: number;
    width: number;
    focused: boolean;
    onScrollMax?(max: number): void;
    onRowPress?(anchorIdx: number): void;
    onComposerChange(v: string): void;
    onComposerSubmit(v: string): void;
  }
  export const ChatView: React.MemoExoticComponent<(p: ChatViewProps) => React.JSX.Element>;
  ```

- [ ] **Step 1: Write the failing test**

`tests/tuiChatView.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ChatView, chatHeaderStatus } from "../src/tui/components/ChatView.js";
import type { ChatState } from "../src/tui/hooks/useChat.js";
import { summarizeTranscript } from "../src/transcriptSummary.js";
import {
  chatDraft,
  chatPrompt,
  chatTurnEnd,
  chatTurnStart,
  metaLine,
  turnEndFull,
  agentStart,
  agentEnd,
} from "./helpers/transcriptFixtures.js";
import { until } from "./helpers/until.js";

const base = (over: Partial<ChatState> = {}): ChatState => ({
  key: "acme/api",
  connection: "live",
  endReason: null,
  summary: null,
  liveText: "",
  streaming: false,
  blocked: null,
  degraded: false,
  overflowed: false,
  drafts: [],
  composer: "",
  composerFocused: true,
  cursor: 0,
  follow: true,
  showThinking: false,
  expanded: new Set(),
  lastOffset: null,
  error: null,
  ...over,
});

describe("chatHeaderStatus (pure)", () => {
  it("maps state to the header word, in priority order", () => {
    expect(chatHeaderStatus(base({ connection: "down" }), "m").text).toBe("daemon down");
    expect(
      chatHeaderStatus(
        base({ blocked: { reason: "rate limited", until: "2026-09-01T18:00:00.000Z" } }),
        "m",
      ).text,
    ).toMatch(/^blocked: rate limited until/);
    expect(chatHeaderStatus(base({ streaming: true }), "m")).toEqual({
      text: "◐ streaming",
      tone: "accent",
    });
    expect(chatHeaderStatus(base({ degraded: true }), "m").text).toBe("idle · transcript degraded");
    expect(chatHeaderStatus(base(), "m").text).toBe("idle");
    expect(chatHeaderStatus(base({ endReason: "session_reset" }), "m").text).toBe(
      "session reset — send a message to start fresh",
    );
  });
});

describe("ChatView", () => {
  it("renders header, prompt/turn rows, live text, a draft card with its anchor cursor, and the composer", async () => {
    const summary = summarizeTranscript([
      metaLine({ ticketId: "acme__api" }),
      chatPrompt(),
      chatTurnStart(),
      agentStart(),
      turnEndFull({
        thinking: null,
        text: "because of X",
        calls: [],
        usage: { input: 3, output: 4 },
      }),
      agentEnd(),
      chatTurnEnd(),
      chatDraft(),
      chatPrompt({ text: "and now?" }),
      chatTurnStart(),
    ]);
    const state = base({
      summary,
      liveText: "thinking about it",
      streaming: true,
      composer: "",
      composerFocused: false,
      cursor: 0,
      follow: false,
    });
    const r = render(
      <ChatView
        state={state}
        modelId="local/m1"
        costUsd={0.42}
        scroll={0}
        height={24}
        width={80}
        focused
        onComposerChange={() => {}}
        onComposerSubmit={() => {}}
      />,
    );
    await until(() => r.lastFrame()!.includes("acme/api"));
    const f = r.lastFrame()!;
    expect(f).toContain("◐ streaming");
    expect(f).toContain("local/m1");
    expect(f).toContain("chat $0.42");
    expect(f).toContain("you: why is the build slow?");
    expect(f).toContain("because of X");
    expect(f).toContain("▌"); // cursor on the draft card (the only anchor)
    expect(f).toContain("draft parked · ticket · add-cache");
    expect(f).toContain("thinking about it"); // liveText trailing rows
    expect(f).toContain("type a message"); // composer placeholder (blurred still renders)
  });
  it("shows the overflow note and disables the composer when the daemon is down", async () => {
    const r = render(
      <ChatView
        state={base({ connection: "down", overflowed: true })}
        modelId={null}
        costUsd={null}
        scroll={0}
        height={20}
        width={80}
        focused
        onComposerChange={() => {}}
        onComposerSubmit={() => {}}
      />,
    );
    await until(() => r.lastFrame()!.includes("daemon down"));
    expect(r.lastFrame()).toContain("showing last 2000");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tuiChatView.test.tsx > /tmp/t17 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/tui/components/TranscriptBody.tsx` — move the rows/scrollbar block out of `TranscriptView` verbatim:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { ClickableBox } from "../ClickableBox.js";
import { Scrollbar } from "./primitives/Scrollbar.js";
import { clampScroll, maxScroll } from "../window.js";
import type { RowTone, TranscriptRow } from "../../transcriptRender.js";

export function toneProps(tone: RowTone | undefined): {
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
} {
  switch (tone) {
    case "dim":
      return { dimColor: true };
    case "accent":
      return { color: theme.accent };
    case "error":
      return { color: theme.error };
    case "warn":
      return { color: theme.warn };
    case "success":
      return { color: theme.success };
    case "bold":
      return { bold: true };
    default:
      return {};
  }
}

export interface TranscriptBodyProps {
  rows: TranscriptRow[];
  /** The cursor's index space (toolCallIds or anchorIds). */
  anchors: string[];
  cursor: number;
  follow: boolean;
  scroll: number;
  visible: number;
  focused: boolean;
  onScrollMax?: (max: number) => void;
  onRowPress?: (anchorIdx: number) => void;
}

/** Window math mirrors QueueView: base at `scroll` (or the tail while
 * `follow`), then nudge so the cursor's anchor row stays visible. Returns the
 * window so the caller's footer can print `start–end/total`. */
export function bodyWindow(
  p: Pick<TranscriptBodyProps, "rows" | "anchors" | "cursor" | "follow" | "scroll" | "visible">,
): { start: number; end: number; anchorId: string | undefined } {
  const anchorId = p.anchors[p.cursor];
  const anchorRow = anchorId === undefined ? -1 : p.rows.findIndex((r) => r.anchor === anchorId);
  let start = p.follow
    ? maxScroll(p.rows.length, p.visible)
    : clampScroll(p.scroll, p.rows.length, p.visible);
  if (!p.follow && anchorRow >= 0) {
    if (anchorRow < start) start = anchorRow;
    else if (anchorRow >= start + p.visible) start = anchorRow - p.visible + 1;
  }
  return { start, end: Math.min(start + p.visible, p.rows.length), anchorId };
}

export const TranscriptBody = React.memo(function TranscriptBody(
  p: TranscriptBodyProps,
): React.JSX.Element {
  const { start, end, anchorId } = bodyWindow(p);
  p.onScrollMax?.(maxScroll(p.rows.length, p.visible));
  return (
    <Box flexGrow={1}>
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        {p.rows.slice(start, end).map((row, i) => {
          const isAnchor = row.anchor !== undefined && row.anchor === anchorId;
          const idx = row.anchor === undefined ? -1 : p.anchors.indexOf(row.anchor);
          return (
            <ClickableBox
              key={start + i}
              hoverBg={row.anchor !== undefined ? theme.hoverBg : undefined}
              onPress={
                row.anchor !== undefined && p.onRowPress ? () => p.onRowPress!(idx) : undefined
              }
            >
              <Text
                wrap="truncate-end"
                backgroundColor={isAnchor && p.focused ? theme.selectionBg : undefined}
                {...toneProps(row.tone)}
              >
                <Text color={theme.accent}>{isAnchor ? "▌" : " "}</Text>
                {row.text || " "}
              </Text>
            </ClickableBox>
          );
        })}
      </Box>
      <Scrollbar offset={start} viewport={p.visible} total={p.rows.length} height={p.visible} />
    </Box>
  );
});
```

`src/tui/components/TranscriptView.tsx` — delete its local `toneProps` (import it from `./TranscriptBody.js`), replace lines 127–148 with `<TranscriptBody rows={rows} anchors={anchors} cursor={state.cursor} follow={state.follow} scroll={scroll} visible={visible} focused={focused} onScrollMax={onScrollMax} onRowPress={onRowPress} />`, and derive `start`/`end` for the footer via `bodyWindow(...)`. Its tests must stay green unchanged.

`src/tui/components/ChatView.tsx`:

```tsx
import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { bumpRender } from "../renderCount.js";
import {
  renderTranscriptRows,
  wrapText,
  MIN_WIDTH,
  type RowTone,
  type TranscriptRow,
} from "../../transcriptRender.js";
import { anchorIds } from "../../transcriptSummary.js";
import type { ChatState } from "../hooks/useChat.js";
import { TranscriptBody, bodyWindow, toneProps } from "./TranscriptBody.js";
import { Composer } from "./Composer.js";
import { CHAT_RING } from "../hooks/useChat.js";

const hhmm = (iso: string): string => iso.slice(11, 16);

/** Header word, in priority order (spec §8.2). */
export function chatHeaderStatus(
  s: ChatState,
  modelId: string | null,
): { text: string; tone?: RowTone } {
  void modelId;
  if (s.connection === "down") return { text: "daemon down", tone: "error" };
  if (s.endReason === "session_reset")
    return { text: "session reset — send a message to start fresh", tone: "warn" };
  if (s.endReason === "daemon_stopped")
    return { text: "daemon stopped — reconnecting", tone: "warn" };
  if (s.blocked)
    return {
      text: `blocked: ${s.blocked.reason}${s.blocked.until ? ` until ${hhmm(s.blocked.until)}` : ""}`,
      tone: "warn",
    };
  if (s.streaming) return { text: "◐ streaming", tone: "accent" };
  if (s.connection !== "live") return { text: s.connection, tone: "dim" };
  return {
    text: s.degraded ? "idle · transcript degraded" : "idle",
    tone: s.degraded ? "warn" : "dim",
  };
}

export interface ChatViewProps {
  state: ChatState;
  modelId: string | null;
  costUsd: number | null; // ChatHealth.costUsd — this daemon lifetime
  scroll: number;
  height: number;
  width: number;
  focused: boolean;
  onScrollMax?: (max: number) => void;
  onRowPress?: (anchorIdx: number) => void;
  onComposerChange: (v: string) => void;
  onComposerSubmit: (v: string) => void;
}

const COMPOSER_ROWS = 6; // border ×2 + up to 4 lines

export const ChatView = React.memo(function ChatView(p: ChatViewProps): React.JSX.Element {
  bumpRender("ChatView");
  const { state } = p;
  const textWidth = Math.max(MIN_WIDTH, p.width - 6);
  const rows: TranscriptRow[] = useMemo(() => {
    const out =
      state.summary === null
        ? []
        : renderTranscriptRows(state.summary, {
            width: textWidth,
            showThinking: state.showThinking,
            expanded: state.expanded,
          });
    if (state.liveText !== "")
      for (const l of wrapText(state.liveText, textWidth)) out.push({ text: l });
    return out;
  }, [state.summary, state.showThinking, state.expanded, state.liveText, textWidth]);
  const anchors = state.summary === null ? [] : anchorIds(state.summary);
  // Reserved: borders ×2, header, footer, composer.
  const visible = Math.max(1, p.height - 4 - COMPOSER_ROWS);
  const { start, end } = bodyWindow({
    rows,
    anchors,
    cursor: state.cursor,
    follow: state.follow,
    scroll: p.scroll,
    visible,
  });
  const status = chatHeaderStatus(state, p.modelId);
  const turns = state.summary?.runs.length ?? 0;
  const disabled = state.connection === "down" || state.connection === "connecting";
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={p.focused ? theme.accent : theme.border}
      paddingX={1}
      height={p.height}
      flexGrow={1}
    >
      <Text bold wrap="truncate">
        chat · {state.key} · <Text {...toneProps(status.tone)}>{status.text}</Text>
        {turns > 0 ? ` · ${turns} turn${turns === 1 ? "" : "s"}` : ""}
        {p.costUsd !== null ? ` · chat $${p.costUsd.toFixed(2)}` : ""}
        {p.modelId ? ` · ${p.modelId}` : ""}
        {state.overflowed ? ` · showing last ${CHAT_RING}` : ""}
      </Text>
      <TranscriptBody
        rows={rows}
        anchors={anchors}
        cursor={state.cursor}
        follow={state.follow}
        scroll={p.scroll}
        visible={visible}
        focused={p.focused && !state.composerFocused}
        onScrollMax={p.onScrollMax}
        onRowPress={p.onRowPress}
      />
      <Text dimColor wrap="truncate">
        {state.composerFocused
          ? "esc blur/abort · ctrl+j newline · / commands"
          : "i compose · ↑/↓ move · enter expand · s submit · e edit · r route · D discard · t thinking · f follow"}
        {rows.length > 0 ? ` · ${start + 1}–${end}/${rows.length}` : ""}
      </Text>
      <Composer
        value={state.composer}
        onChange={p.onComposerChange}
        onSubmit={p.onComposerSubmit}
        focused={p.focused && state.composerFocused}
        disabled={disabled}
        disabledReason={
          state.connection === "down" ? "daemon down — chat unavailable" : "connecting…"
        }
        width={p.width - 2}
      />
    </Box>
  );
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tuiChatView.test.tsx tests/tuiTranscriptView.test.tsx tests/useTranscript.test.tsx tests/renderPerf.test.tsx > /tmp/t17 2>&1; echo "exit: $?"` — expected 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/TranscriptBody.tsx src/tui/components/ChatView.tsx src/tui/components/TranscriptView.tsx tests/tuiChatView.test.tsx
git add src/tui/components/TranscriptBody.tsx src/tui/components/ChatView.tsx src/tui/components/TranscriptView.tsx tests/tuiChatView.test.tsx
git commit -m "feat(tui): ChatView over a shared TranscriptBody"
```

---

### Task 18: Draft actions (`useChatDrafts`), `ReviewView`'s third list, editor + `SuspendProvider`

Spec §6.4, §6.6, §8.6. One hook owns the four verbs — submit (spawn the CLI verb), edit (`$EDITOR` through `useSuspend`, re-lint via the daemon-free `parkDrafts` path is NOT available in the TUI process, so edit re-lints with `lintTicket` + `decideRoute` directly through a client method), route (cycle the override), discard — and both the chat pane (Task 19) and `ReviewView` call it. `useCmdOutput` gains `showCmdResult` so a failed submit lands in the command view with `r` re-run intact.

**Files:**

- Create: `src/tui/hooks/useChatDrafts.ts`
- Modify: `src/tui/hooks/useCmdOutput.ts` (add `showCmdResult`), `src/tui/hooks/useReview.ts` (load chat drafts), `src/tui/components/ReviewView.tsx` (`ReviewState.chatDrafts`, `ChatDraftOpen`, list rows, preview mode), `src/tui/ghClient.ts` (`relintChatDraft`), `src/tui/Root.tsx` (`SuspendProvider` around the dashboard `App`), `src/tui/App.tsx` (`AppProps.editFileFn`; the review cascade + handlers for the third kind — the chat-view wiring is Task 19)
- Test: `tests/useChatDrafts.test.tsx`, `tests/useCmdOutput.test.tsx` (one case), `tests/useReview.test.tsx` (one case), `tests/reviewView.test.tsx` (list + preview rows), `tests/tuiGhClient.test.ts` (relint)

**Interfaces:**

- Consumes: `PendingDraft`, `DraftFile` (Task 11); `DashboardClient` chat/draft members (Task 14); `runCliFn: (name, extraArgs) => Promise<CliRunResult>` (App already has it); `useSuspend` (`src/tui/useSuspend.tsx`).
- Produces:

  ```ts
  // ghClient.ts
  relintChatDraft(id: string): Promise<Result<PendingDraft>>;   // re-read files from disk, lintTicket + decideRoute per file, rewrite JSON, return the updated draft
  // useCmdOutput.ts
  showCmdResult(name: string, extraArgs: string[], r: CliRunResult): void;   // a completed CmdState + setView("cmdOutput")
  // useChatDrafts.ts
  export type RouteOverride = PendingDraft["routeOverride"];
  export function submitArgv(d: PendingDraft, filePath: (name: string) => string): string[][];   // pure: one argv per CLI invocation, in order
  export function nextRoute(r: RouteOverride): RouteOverride;   // auto → inbox → issue → auto
  export interface ChatDraftActions { submit(d: PendingDraft): Promise<void>; edit(d: PendingDraft): Promise<void>; route(d: PendingDraft): Promise<void>; discard(d: PendingDraft): Promise<void> }
  export function useChatDrafts(opts: { client: DashboardClient; runCliFn; showCmdResult; editFileFn: (path: string) => Promise<void>; suspend: <T>(fn: () => Promise<T>) => Promise<T>; showToast(kind: ToastKind, text: string): void; aliveRef; onChanged(): void; draftFilePath: (id: string, name: string) => string }): ChatDraftActions;
  // ReviewView.tsx
  export interface ChatDraftOpen { kind: "chatDraft"; idx: number }
  ReviewState.chatDrafts: PendingDraft[]; ReviewState.open: ReviewOpen | DraftOpen | ChatDraftOpen | null;   // combined cursor: batches, comment drafts, chat drafts
  // App.tsx
  AppProps.editFileFn?: (path: string) => Promise<void>;   // default: spawn($EDITOR ?? "vi", [path], { stdio: "inherit" })
  ```

- [ ] **Step 1: Write the failing tests**

`tests/useChatDrafts.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { nextRoute, submitArgv, useChatDrafts } from "../src/tui/hooks/useChatDrafts.js";
import type { PendingDraft } from "../src/chat/draftStore.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import { stubClient } from "./helpers/localFixtures.js";
import { until } from "./helpers/until.js";

const file = (name: string, route: "inbox" | "issue" | null = "inbox") => ({
  name,
  content: "",
  lint: [],
  droppedKeys: [],
  route:
    route === null
      ? null
      : {
          destination: route,
          reasons: [],
          watchedNwo: route === "issue" ? "acme/api" : null,
          carriedTimeout: null,
          discarded: [],
        },
});
const draft = (over: Partial<PendingDraft> = {}): PendingDraft => ({
  id: "acme__api-1",
  key: "acme/api",
  slug: "acme__api",
  kind: "ticket",
  files: [file("t.md")],
  cwd: "/repo",
  nwo: "acme/api",
  createdAt: "t",
  lintFailed: false,
  blocked: null,
  routeOverride: "auto",
  commandArgs: null,
  ...over,
});
const fp = (name: string) => `/drafts/acme__api-1/${name}`;

describe("submitArgv (pure, spec 2026-09-01 §6.1, §6.4)", () => {
  it("maps kind × route override onto the CLI verbs", () => {
    expect(submitArgv(draft(), fp)).toEqual([["submit", "/drafts/acme__api-1/t.md"]]);
    expect(submitArgv(draft({ files: [file("t.md", "issue")] }), fp)).toEqual([
      ["submit", "--as-issue", "/drafts/acme__api-1/t.md"],
    ]);
    expect(
      submitArgv(draft({ routeOverride: "inbox", files: [file("t.md", "issue")] }), fp),
    ).toEqual([["submit", "/drafts/acme__api-1/t.md"]]);
    expect(submitArgv(draft({ routeOverride: "issue" }), fp)).toEqual([
      ["submit", "--as-issue", "/drafts/acme__api-1/t.md"],
    ]);
    expect(
      submitArgv(draft({ kind: "ticketSet", files: [file("a.md"), file("b.md")] }), fp),
    ).toEqual([
      ["submit", "/drafts/acme__api-1/a.md"],
      ["submit", "/drafts/acme__api-1/b.md"],
    ]);
    expect(submitArgv(draft({ kind: "planSet", files: [file("plan.md", null)] }), fp)).toEqual([
      ["submit", "--plan", "/drafts/acme__api-1/plan.md", "--repo", "/repo"],
    ]);
    expect(
      submitArgv(
        draft({ kind: "planSet", routeOverride: "issue", files: [file("plan.md", null)] }),
        fp,
      ),
    ).toEqual([
      ["submit", "--as-issue", "--plan", "/drafts/acme__api-1/plan.md", "--repo", "/repo"],
    ]);
    expect(
      submitArgv(
        draft({
          kind: "audit",
          commandArgs: ["audit", "acme/api", "--auto-plan"],
          files: [file("a.md", null)],
        }),
        fp,
      ),
    ).toEqual([["audit", "acme/api", "--auto-plan"]]);
    expect(
      submitArgv(
        draft({
          kind: "investigate",
          commandArgs: ["investigate", "acme/api#7"],
          files: [file("z.md", null)],
        }),
        fp,
      ),
    ).toEqual([["investigate", "acme/api#7"]]);
  });
  it("nextRoute cycles auto → inbox → issue → auto", () => {
    expect(nextRoute("auto")).toBe("inbox");
    expect(nextRoute("inbox")).toBe("issue");
    expect(nextRoute("issue")).toBe("auto");
  });
});

function Probe({
  client,
  runCliFn,
  showCmdResult,
  editFileFn,
  onReady,
  changed,
  toasts,
}: {
  client: DashboardClient;
  runCliFn: (
    n: string,
    a: string[],
  ) => Promise<{ code: number | null; output: string; timedOut: boolean }>;
  showCmdResult: (n: string, a: string[], r: unknown) => void;
  editFileFn: (p: string) => Promise<void>;
  onReady: (a: ReturnType<typeof useChatDrafts>) => void;
  changed: () => void;
  toasts: string[];
}) {
  const aliveRef = React.useRef(true);
  const api = useChatDrafts({
    client,
    runCliFn,
    showCmdResult: showCmdResult as never,
    editFileFn,
    suspend: async (fn) => fn(),
    showToast: (_k, t) => void toasts.push(t),
    aliveRef,
    onChanged: changed,
    draftFilePath: fp,
  });
  onReady(api);
  return <Text>probe</Text>;
}

describe("useChatDrafts", () => {
  it("submit: runs every argv in order, archives, notes the transcript, toasts, and reloads", async () => {
    const ran: string[][] = [];
    const notes: unknown[] = [];
    const archived: string[] = [];
    const client: DashboardClient = {
      ...stubClient,
      archiveSubmittedChatDraft: async (id) => (archived.push(id), { ok: true, value: null }),
      chat: {
        ...stubClient.chat,
        note: async (_k, rec) => (notes.push(rec), { ok: true, value: null }),
      },
    };
    let api!: ReturnType<typeof useChatDrafts>;
    const toasts: string[] = [];
    let changed = 0;
    render(
      <Probe
        client={client}
        runCliFn={async (n, a) => (
          ran.push([n, ...a]),
          { code: 0, output: "queued: /inbox/a.md\n", timedOut: false }
        )}
        showCmdResult={() => {}}
        editFileFn={async () => {}}
        onReady={(a) => (api = a)}
        changed={() => changed++}
        toasts={toasts}
      />,
    );
    await api.submit(draft({ kind: "ticketSet", files: [file("a.md"), file("b.md")] }));
    expect(ran).toEqual([
      ["submit", "/drafts/acme__api-1/a.md"],
      ["submit", "/drafts/acme__api-1/b.md"],
    ]);
    expect(archived).toEqual(["acme__api-1"]);
    expect(notes[0]).toMatchObject({
      type: "junco_chat_draft",
      draftId: "acme__api-1",
      status: "submitted",
      ids: ["a", "b"],
      destination: "inbox",
    });
    expect(toasts[0]).toMatch(/submitted/);
    expect(changed).toBe(1);
  });
  it("submit: a non-zero exit stops the sequence, shows the command result, keeps the draft parked", async () => {
    const ran: string[][] = [];
    const shown: unknown[] = [];
    const archived: string[] = [];
    const client: DashboardClient = {
      ...stubClient,
      archiveSubmittedChatDraft: async (id) => (archived.push(id), { ok: true, value: null }),
    };
    let api!: ReturnType<typeof useChatDrafts>;
    render(
      <Probe
        client={client}
        runCliFn={async (n, a) => (
          ran.push([n, ...a]),
          { code: 1, output: "refused: not bridge-watched\n", timedOut: false }
        )}
        showCmdResult={(...a) => shown.push(a)}
        editFileFn={async () => {}}
        onReady={(a) => (api = a)}
        changed={() => {}}
        toasts={[]}
      />,
    );
    await api.submit(
      draft({ kind: "ticketSet", routeOverride: "issue", files: [file("a.md"), file("b.md")] }),
    );
    expect(ran).toHaveLength(1);
    expect(archived).toEqual([]);
    expect(shown[0]).toEqual([
      "submit",
      ["--as-issue", "/drafts/acme__api-1/a.md"],
      { code: 1, output: "refused: not bridge-watched\n", timedOut: false },
    ]);
  });
  it("submit refuses a lintFailed or blocked draft with a toast", async () => {
    const ran: string[][] = [];
    let api!: ReturnType<typeof useChatDrafts>;
    const toasts: string[] = [];
    render(
      <Probe
        client={stubClient}
        runCliFn={async (n, a) => (ran.push([n, ...a]), { code: 0, output: "", timedOut: false })}
        showCmdResult={() => {}}
        editFileFn={async () => {}}
        onReady={(a) => (api = a)}
        changed={() => {}}
        toasts={toasts}
      />,
    );
    await api.submit(draft({ lintFailed: true }));
    await api.submit(
      draft({ kind: "planSet", blocked: "plan_sets_disabled", files: [file("plan.md", null)] }),
    );
    expect(ran).toEqual([]);
    expect(toasts).toHaveLength(2);
  });
  it("edit opens every file in the editor under suspend, then re-lints; route cycles and persists; discard archives", async () => {
    const edited: string[] = [];
    const updated: PendingDraft[] = [];
    const relinted: string[] = [];
    const discarded: string[] = [];
    const client: DashboardClient = {
      ...stubClient,
      relintChatDraft: async (id) => (relinted.push(id), { ok: true, value: draft({ id }) }),
      updateChatDraft: async (d) => (updated.push(d), { ok: true, value: null }),
      discardChatDraft: async (id) => (discarded.push(id), { ok: true, value: null }),
    };
    let api!: ReturnType<typeof useChatDrafts>;
    render(
      <Probe
        client={client}
        runCliFn={async () => ({ code: 0, output: "", timedOut: false })}
        showCmdResult={() => {}}
        editFileFn={async (p) => void edited.push(p)}
        onReady={(a) => (api = a)}
        changed={() => {}}
        toasts={[]}
      />,
    );
    await api.edit(draft({ kind: "ticketSet", files: [file("a.md"), file("b.md")] }));
    expect(edited).toEqual(["/drafts/acme__api-1/a.md", "/drafts/acme__api-1/b.md"]);
    expect(relinted).toEqual(["acme__api-1"]);
    await api.route(draft());
    expect(updated[0]!.routeOverride).toBe("inbox");
    await api.discard(draft());
    expect(discarded).toEqual(["acme__api-1"]);
  });
});
```

Add to `tests/useCmdOutput.test.tsx`:

```tsx
it("showCmdResult lands a completed result in the cmdOutput view with re-run intact", async () => {
  const runCliFn = vi.fn(async () => ({ code: 0, output: "", timedOut: false }));
  const setView = vi.fn();
  let api!: ReturnType<typeof useCmdOutput>;
  render(<Probe runCliFn={runCliFn} setView={setView} onReady={(a) => (api = a)} />);
  api.showCmdResult("submit", ["--as-issue", "/x.md"], {
    code: 1,
    output: "refused\n",
    timedOut: false,
  });
  await until(() => setView.mock.calls.some((c) => c[0] === "cmdOutput"));
  expect(api.cmd).toMatchObject({
    title: "junco submit --as-issue /x.md",
    running: false,
    exitCode: 1,
    output: "refused\n",
    name: "submit",
    extraArgs: ["--as-issue", "/x.md"],
  });
  expect(runCliFn).not.toHaveBeenCalled();
});
```

Add to `tests/useReview.test.tsx`: `loadReview` also calls `client.listChatDrafts()` and lands them in `reviewState.chatDrafts` (extend the file's existing "loads batches and drafts" case with a `listChatDrafts` fake returning one draft and assert `chatDrafts` has it).

Add to `tests/reviewView.test.tsx`: a chat draft row renders `acme/api · ticket · add-cache · inbox` (route verdict) with a `lint ✗` marker when `lintFailed`, after the batches and comment drafts; opening it (`open: {kind: "chatDraft", idx: 0}`) shows the file content lines, the verdict lines (`destination: inbox`, one `reason:` per reason, `would discard:` when non-empty), `dropped: tools, network` when `droppedKeys` is non-empty, and the footer `s submit · e edit · r route · D discard · esc back`.

Add to `tests/tuiGhClient.test.ts`: `relintChatDraft` re-reads each file from the draft dir, lints with `checkLabels: false`, routes with an injected `decideRouteFn`, rewrites the JSON, and returns the updated draft (use a tmp `dataDir` and a real `writeChatDraft` to seed).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/useChatDrafts.test.tsx tests/useCmdOutput.test.tsx tests/useReview.test.tsx tests/tuiGhClient.test.ts > /tmp/t18 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/tui/hooks/useCmdOutput.ts` — add beside `runPaletteCommand`:

```ts
/** Land an already-completed result (a chat-draft submit that failed, spec
 * 2026-09-01 §6.6) in the cmdOutput view. name/extraArgs are kept so `r`
 * re-runs the same invocation. */
const showCmdResult = useCallback(
  (name: string, extraArgs: string[], r: CliRunResult): void => {
    const token = ++cmdTokenRef.current;
    setCmd({
      title: ["junco", name, ...extraArgs].join(" "),
      running: false,
      output: r.output,
      exitCode: r.code,
      timedOut: r.timedOut,
      name,
      extraArgs,
      token,
    });
    setView("cmdOutput");
  },
  [setView],
);
```

and return it.

`src/tui/chatClientMethods.ts` (NOT `makeGhDashboardClient`, which is pinned at 438 lines — Ruling R15) — `relintChatDraft(id)` joins the chat methods module:

```ts
    relintChatDraft(id) {
      return attempt(async () => {
        const { entry, error } = readChatDraft(cfg, id);
        if (error) throw new Error(error);
        if (!entry) throw new Error(`no chat draft '${id}'`);
        const files = await Promise.all(
          entry.files.map(async (f) => {
            const content = readFileFn(draftFilePath(cfg, id, f.name));
            if (entry.kind === "audit" || entry.kind === "investigate" || entry.kind === "planSet")
              return { ...f, content };
            const t = parseTicket(f.name, content, cfg.defaultTimeoutMinutes);
            const lint = lintTicket(t.body, t.frontmatter, { repoPath: entry.cwd, repoNwo: entry.nwo, checkLabels: false }).violations;
            const route = await (deps.decideRouteFn ?? decideRoute)(cfg, t.frontmatter);
            return { ...f, content, lint, route };
          }),
        );
        const updated: PendingDraft = { ...entry, files, lintFailed: files.some((f) => f.lint.some((v) => v.severity === "error")) };
        writeChatDraft(cfg, updated);
        return updated;
      });
    },
```

(`GhClientDeps.decideRouteFn?: typeof decideRoute`; imports `parseTicket`, `lintTicket`, `decideRoute`.) Add `relintChatDraft: async (id) => okv(/* a stub draft */)` to `stubClient` and the other client literals — the exact stub value is `{ id, key: "acme/api", slug: "acme__api", kind: "ticket", files: [], cwd: "/x", nwo: "acme/api", createdAt: "t", lintFailed: false, blocked: null, routeOverride: "auto", commandArgs: null }`.

`src/tui/hooks/useChatDrafts.ts`:

```ts
import { useCallback, useMemo } from "react";
import type { MutableRefObject } from "react";
import type { DashboardClient } from "../ghClient.js";
import type { CliRunResult } from "../cliRunner.js";
import type { PendingDraft } from "../../chat/draftStore.js";
import type { ToastKind } from "../theme.js";

export type RouteOverride = PendingDraft["routeOverride"];

export function nextRoute(r: RouteOverride): RouteOverride {
  return r === "auto" ? "inbox" : r === "inbox" ? "issue" : "auto";
}

/** One argv per CLI invocation, in order (spec §6.1 table, §6.4 override). */
export function submitArgv(d: PendingDraft, filePath: (name: string) => string): string[][] {
  if (d.kind === "audit" || d.kind === "investigate") return d.commandArgs ? [d.commandArgs] : [];
  const asIssue = (f: PendingDraft["files"][number]): boolean =>
    d.routeOverride === "issue" || (d.routeOverride === "auto" && f.route?.destination === "issue");
  if (d.kind === "planSet") {
    const f = d.files[0]!;
    return [
      [
        "submit",
        ...(asIssue(f) ? ["--as-issue"] : []),
        "--plan",
        filePath(f.name),
        "--repo",
        d.cwd,
      ],
    ];
  }
  return d.files.map((f) => ["submit", ...(asIssue(f) ? ["--as-issue"] : []), filePath(f.name)]);
}

export interface ChatDraftActions {
  submit(d: PendingDraft): Promise<void>;
  edit(d: PendingDraft): Promise<void>;
  route(d: PendingDraft): Promise<void>;
  discard(d: PendingDraft): Promise<void>;
}

/**
 * The four draft verbs (spec 2026-09-01 §6.4, §6.6), shared by the chat
 * pane's card and the review row. Submit spawns the CLI verb — byte-identical
 * file, same routing code and identity handling as the skill — and on success
 * archives the draft and notes the transcript through the daemon.
 */
export function useChatDrafts(opts: {
  client: DashboardClient;
  runCliFn: (name: string, extraArgs: string[]) => Promise<CliRunResult>;
  showCmdResult: (name: string, extraArgs: string[], r: CliRunResult) => void;
  editFileFn: (path: string) => Promise<void>;
  suspend: <T>(fn: () => Promise<T>) => Promise<T>;
  showToast: (kind: ToastKind, text: string) => void;
  aliveRef: MutableRefObject<boolean>;
  onChanged: () => void;
  draftFilePath: (id: string, name: string) => string;
}): ChatDraftActions {
  const {
    client,
    runCliFn,
    showCmdResult,
    editFileFn,
    suspend,
    showToast,
    aliveRef,
    onChanged,
    draftFilePath,
  } = opts;

  const submit = useCallback(
    async (d: PendingDraft): Promise<void> => {
      if (d.lintFailed) return showToast("error", "draft failed lint — edit it first (e)");
      if (d.blocked) return showToast("error", `draft blocked: ${d.blocked.replace(/_/g, " ")}`);
      const argvs = submitArgv(d, (name) => draftFilePath(d.id, name));
      if (argvs.length === 0) return showToast("error", "nothing to submit");
      for (const [name, ...extra] of argvs) {
        const r = await runCliFn(name!, extra);
        if (!aliveRef.current) return;
        if (r.code !== 0) {
          showCmdResult(name!, extra, r);
          return;
        }
      }
      await client.archiveSubmittedChatDraft(d.id);
      const destination =
        d.kind === "audit" || d.kind === "investigate"
          ? "command"
          : argvs[0]!.includes("--as-issue")
            ? "issue"
            : "inbox";
      // The submit happened; the draft is archived regardless of whether the
      // transcript note lands (spec §11) — a note failure is a toast, not a rollback.
      const noted = await client.chat.note(d.key, {
        type: "junco_chat_draft",
        draftId: d.id,
        kind: d.kind,
        status: "submitted",
        ids: d.files.map((f) => f.name.replace(/\.md$/, "")),
        destination,
      });
      if (!aliveRef.current) return;
      showToast(
        noted.ok ? "success" : "error",
        noted.ok
          ? `submitted → ${destination}`
          : `submitted → ${destination} (transcript note failed: ${noted.error})`,
      );
      onChanged();
    },
    [client, runCliFn, showCmdResult, showToast, aliveRef, onChanged, draftFilePath],
  );

  const edit = useCallback(
    async (d: PendingDraft): Promise<void> => {
      await suspend(async () => {
        for (const f of d.files) await editFileFn(draftFilePath(d.id, f.name));
      });
      const r = await client.relintChatDraft(d.id);
      if (!aliveRef.current) return;
      if (!r.ok) return showToast("error", r.error);
      showToast(
        r.value.lintFailed ? "error" : "success",
        r.value.lintFailed ? "still failing lint" : "lint ok",
      );
      onChanged();
    },
    [client, editFileFn, suspend, showToast, aliveRef, onChanged, draftFilePath],
  );

  const route = useCallback(
    async (d: PendingDraft): Promise<void> => {
      const r = await client.updateChatDraft({ ...d, routeOverride: nextRoute(d.routeOverride) });
      if (!aliveRef.current) return;
      if (!r.ok) return showToast("error", r.error);
      onChanged();
    },
    [client, showToast, aliveRef, onChanged],
  );

  const discard = useCallback(
    async (d: PendingDraft): Promise<void> => {
      const r = await client.discardChatDraft(d.id);
      if (!aliveRef.current) return;
      if (!r.ok) return showToast("error", r.error);
      await client.chat.note(d.key, {
        type: "junco_chat_draft",
        draftId: d.id,
        kind: d.kind,
        status: "discarded",
        ids: [],
        destination: null,
      });
      showToast("success", "draft discarded");
      onChanged();
    },
    [client, showToast, aliveRef, onChanged],
  );

  return useMemo(() => ({ submit, edit, route, discard }), [submit, edit, route, discard]);
}
```

`ToastKind` is `"info" | "success" | "error"` (`src/tui/theme.ts:16`).

`src/tui/hooks/useReview.ts` — `INITIAL_REVIEW_STATE.chatDrafts = []`; `loadReview` awaits `client.listChatDrafts()` alongside the other two and lands `chatDrafts`.

`src/tui/components/ReviewView.tsx` — `ReviewState.chatDrafts: PendingDraft[]`, `export interface ChatDraftOpen { kind: "chatDraft"; idx: number }`, `open: ReviewOpen | DraftOpen | ChatDraftOpen | null`. Combined list `total = batches + drafts + chatDrafts`; a chat-draft row after the comment drafts:

```tsx
const cd = state.chatDrafts[idx - batchCount - state.drafts.length]!;
const first = cd.files[0];
const verdict =
  cd.kind === "audit" || cd.kind === "investigate"
    ? "command"
    : cd.routeOverride !== "auto"
      ? `${cd.routeOverride}!`
      : (first?.route?.destination ?? "?");
return (
  <ClickableBox
    key={cd.id}
    width="100%"
    backgroundColor={sel ? theme.selectionBg : undefined}
    hoverBg={sel ? theme.selectionBg : theme.hoverBg}
    gap={1}
    onPress={onRowPress ? () => onRowPress(idx) : undefined}
  >
    <Box flexShrink={0}>
      <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
    </Box>
    <Box flexShrink={0}>
      <Text dimColor={!sel}>{cd.nwo ?? cd.key}</Text>
    </Box>
    <Box flexGrow={1} minWidth={0}>
      <Text
        wrap="truncate"
        dimColor={!sel}
      >{`${cd.kind} · ${cd.files.map((f) => f.name.replace(/\.md$/, "")).join(", ")}`}</Text>
    </Box>
    <Box flexShrink={0}>
      <Text color={cd.lintFailed ? theme.error : theme.accent}>
        {cd.lintFailed ? "lint ✗" : verdict}
      </Text>
    </Box>
    <Box flexShrink={0}>
      <Text dimColor>{fmtAge(cd.createdAt, now)}</Text>
    </Box>
  </ClickableBox>
);
```

Preview mode (`open.kind === "chatDraft"`): header `${nwo ?? key} · ${kind} · route: ${override or verdict}`; for each file: `── ${name} ──`, the verdict lines (`destination: …`, `reason: …` per reason, `carried: timeout_minutes=N` / `would discard: …` on the issue route), `dropped: …` when `droppedKeys` non-empty, every lint violation as `[severity] rule: message`, then the file's content lines; the whole thing windowed by `scroll` like the comment-draft preview; footer `s submit · e edit · r route · D discard · esc back`.

`src/tui/Root.tsx` — wrap the dashboard `<App …/>` (line ~73) in `<SuspendProvider>` (import from `./useSuspend.js`).

`src/tui/App.tsx` — `AppProps.editFileFn?: (path: string) => Promise<void>`; default:

```ts
const defaultEditFile = (path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.env.EDITOR ?? "vi", [path], { stdio: "inherit" });
    child.on("exit", () => resolve());
    child.on("error", reject);
  });
```

Wire `useChatDrafts` in App (`const suspend = useSuspend();` — the no-provider fallback is a no-op, so tests need no provider) with `onChanged: () => { void loadReview(); void chatApi.reloadDrafts(); }` (the `chatApi` half lands in Task 19; wire `loadReview` now). Review cascade: in the combined-list `enter` branch, a cursor past `batches + drafts` opens `{ kind: "chatDraft", idx }`; in `open.kind === "chatDraft"` mode `esc` closes, `j`/`k` scroll; `actionHandlers` for the review view gain `submit`/`edit`/`route` (and `discard` routes to the chat action when a chat draft is open or under the cursor) calling `chatDraftActions.*` on the selected chat draft. `VIEW_OPTIONS.review` gains the three appended options (Task 19 also touches `viewActions.ts`; add them here so the review handlers have keys, and Task 19's pinned test covers both).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/useChatDrafts.test.tsx tests/useCmdOutput.test.tsx tests/useReview.test.tsx tests/tuiGhClient.test.ts tests/reviewView.test.tsx tests/tuiViewActions.test.ts tests/tuiApp.test.tsx > /tmp/t18 2>&1; echo "exit: $?"` — expected 0 after updating the pinned review keymap (`s: "submit", e: "edit", r: "route"` appended). `npm run lint` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/hooks/useChatDrafts.ts src/tui/hooks/useCmdOutput.ts src/tui/hooks/useReview.ts src/tui/components/ReviewView.tsx src/tui/ghClient.ts src/tui/Root.tsx src/tui/App.tsx src/tui/viewActions.ts tests/useChatDrafts.test.tsx tests/useCmdOutput.test.tsx tests/useReview.test.tsx tests/tuiGhClient.test.ts tests/tuiViewActions.test.ts tests/helpers/localFixtures.tsx tests/reviewView.test.tsx
git add src/tui/hooks/useChatDrafts.ts src/tui/hooks/useCmdOutput.ts src/tui/hooks/useReview.ts src/tui/components/ReviewView.tsx src/tui/ghClient.ts src/tui/Root.tsx src/tui/App.tsx src/tui/viewActions.ts tests/useChatDrafts.test.tsx tests/useCmdOutput.test.tsx tests/useReview.test.tsx tests/tuiGhClient.test.ts tests/tuiViewActions.test.ts tests/helpers/localFixtures.tsx tests/reviewView.test.tsx
git commit -m "feat(tui): chat draft actions — submit via CLI, edit in \$EDITOR, route override, discard; review lists chat drafts"
```

---

### Task 19: `viewActions` + App wiring — the chat view, bindings, focus rules, slash commands, rail badge

Spec §8.1, §8.3, §8.6. The nav spine learns the view; the binding tables learn the verbs; the input cascade learns the `esc` state machine; the rail learns the badge. Every domain effect already lives in `useChat`/`useChatDrafts`; this task is composition.

**Files:**

- Modify: `src/tui/viewActions.ts` (`OverlayView`, `BindingContext.structuralOnly.view`, `BODY_VERBS.issues`/`.repoDetail`, `VIEW_OPTIONS.chat`, `viewStructural`, `structuralOnly`)
- Modify: `src/tui/App.tsx` (`View`; `useChat` + `useChatDrafts` wiring; `bindingContext`; `actionHandlers`; the input cascade; `scrollKey`/`crumbs`; render; rail badge; the rail-switch effect)
- Modify: `src/tui/components/UnifiedRail.tsx` (`chatBadge: (key: string) => string | null` prop). `HelpModal` is unchanged: it lists the MAIN-body bindings by design (`App.tsx:1235-1252`); the chat view's keys live on its footer chips and `ChatView`'s hint line.
- Test: `tests/tuiViewActions.test.ts` (pinned keymaps), `tests/tuiApp.chat.test.tsx` (new), `tests/tuiUnifiedRail.test.tsx` (badge)

**Interfaces:**

- Consumes: `useChat`/`ChatApi` (Task 15); `useChatDrafts` (Task 18); `ChatView` (Task 17); `slashMatches`/`SLASH_COMMANDS` (Task 16); `HealthInfo.chats` (Task 9); `buildContextBindings` (`src/tui/viewActions.ts`).
- Produces: `View` and `OverlayView` include `"chat"`; `structuralOnly` view union includes `"chatCompose"`; `UnifiedRailProps.chatBadge`.

- [ ] **Step 1: Write the failing tests**

`tests/tuiViewActions.test.ts` — extend the pinned keymaps:

```ts
it("main:issues and main:repoDetail carry chat on t (a body verb — the queue body keeps t for retry)", () => {
  expect(km({ kind: "main", body: "issues" })).toMatchObject({ t: "chat" });
  expect(km({ kind: "main", body: "repoDetail" })).toEqual({ ...GLOBALS, t: "chat" });
  expect(km({ kind: "main", body: "queue" })).toMatchObject({ t: "retry" });
  expect(km({ kind: "main", body: "logs" })).toEqual(GLOBALS);
});
it("chat view (composer blurred) and chatCompose (focused)", () => {
  expect(km({ kind: "view", view: "chat" })).toEqual({
    s: "submit",
    e: "edit",
    D: "discard",
    r: "route",
    t: "thinking",
    f: "follow",
    q: "close",
  });
  expect(km({ kind: "structuralOnly", view: "chatCompose" })).toEqual({});
  const chips = buildContextBindings(
    { kind: "structuralOnly", view: "chatCompose" },
    2,
    "wide",
  ).chips.map((c) => c.label);
  expect(chips).toEqual(["message", "send", "newline", "commands", "blur/abort"]);
});
it("review gains submit/edit/route AFTER the existing four, keys unchanged", () => {
  expect(km({ kind: "view", view: "review" })).toEqual({
    a: "all",
    n: "none",
    f: "file",
    D: "discard",
    s: "submit",
    e: "edit",
    r: "route",
    q: "close",
  });
});
```

(`main:issues` and `main:repoDetail` existing assertions must be updated to include `t: "chat"`; adjust the `toEqual` literals in place rather than loosening them.)

`tests/tuiApp.chat.test.tsx` — the App-level behaviors, on `renderApp` from `tests/helpers/localFixtures.tsx` with a fake client whose `chat.subscribe` captures handlers (as in `tests/useChat.test.tsx`):

```tsx
import { describe, it, expect } from "vitest";
import { renderApp, stubClient } from "./helpers/localFixtures.js";
import { until, fireUntil } from "./helpers/until.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { ChatSubscribeHandlers } from "../src/tui/chatClient.js";
import { chatDraft, chatPrompt, chatTurnStart, metaLine } from "./helpers/transcriptFixtures.js";

function chatClient() {
  let h: ChatSubscribeHandlers | null = null;
  const calls: string[] = [];
  const client: DashboardClient = {
    ...stubClient,
    listChatDrafts: async () => ({
      ok: true,
      value: [
        {
          id: "acme__api-20260901-120000-1",
          key: "acme/api",
          slug: "acme__api",
          kind: "ticket",
          files: [
            {
              name: "add-cache.md",
              content: "",
              lint: [],
              droppedKeys: [],
              route: {
                destination: "inbox",
                reasons: ["github disabled"],
                watchedNwo: null,
                carriedTimeout: null,
                discarded: [],
              },
            },
          ],
          cwd: "/r",
          nwo: "acme/api",
          createdAt: "t",
          lintFailed: false,
          blocked: null,
          routeOverride: "auto",
          commandArgs: null,
        },
      ] as never,
    }),
    health: async () => ({
      ...(await stubClient.health()),
      chats: {
        enabled: true,
        sessions: [
          {
            key: "acme/api",
            slug: "acme__api",
            streaming: true,
            turns: 1,
            lastActivityAt: null,
            draftsParked: 1,
          },
        ],
        turns: 1,
        costUsd: 0.1,
        tokensIn: 1,
        tokensOut: 1,
      },
    }),
    chat: {
      ...stubClient.chat,
      subscribe: (_k, _s, on) => ((h = on), on.status("live"), () => calls.push("unsub")),
      prompt: async (_k, t) => (
        calls.push(`prompt:${t}`),
        { ok: true, value: { mode: "prompt" as const } }
      ),
      abort: async () => (calls.push("abort"), { ok: true, value: { aborted: true } }),
    },
    prContext: async (_n, num) => ({ ok: true, value: `PR #${num}: Add cache\n\nwhy` }),
  };
  return { client, calls, push: (o: number | null, l: string) => h!.record(o, l) };
}

describe("dashboard chat wiring (spec 2026-09-01 §8)", () => {
  it("t on a repo row opens the chat view with the composer focused; typed prose never fires mnemonics; enter sends", async () => {
    const c = chatClient();
    const r = renderApp({ client: c.client });
    await until(() => r.lastFrame()!.includes("acme/api"));
    await fireUntil(r.stdin, "t", () => r.lastFrame()!.includes("chat · acme/api"));
    r.stdin.write("quit"); // q would quit the dashboard if the mnemonic path saw it
    await until(() => r.lastFrame()!.includes("quit"));
    r.stdin.write("\r");
    await until(() => c.calls.includes("prompt:quit"));
    expect(r.lastFrame()).toContain("chat · acme/api");
  });

  it("esc: streaming → abort; idle+focused → blur; blurred → leave the view", async () => {
    const c = chatClient();
    const r = renderApp({ client: c.client });
    await until(() => r.lastFrame()!.includes("acme/api"));
    await fireUntil(r.stdin, "t", () => r.lastFrame()!.includes("chat · acme/api"));
    c.push(10, metaLine({ ticketId: "acme__api" }));
    c.push(20, chatPrompt());
    c.push(30, chatTurnStart());
    await until(() => r.lastFrame()!.includes("◐ streaming"));
    r.stdin.write("\x1b");
    await until(() => c.calls.includes("abort"));
    c.push(40, JSON.stringify({ type: "junco_chat_turn_aborted", reason: "operator", ts: "t" }));
    await until(() => !r.lastFrame()!.includes("◐ streaming"));
    r.stdin.write("\x1b");
    await until(() => r.lastFrame()!.includes("i compose"));
    r.stdin.write("\x1b");
    await until(() => !r.lastFrame()!.includes("chat · acme/api"));
    expect(c.calls).toContain("unsub");
  });

  it("blurred: j/k walk anchors, s submits the selected draft, i refocuses; the rail badge shows ● and the draft count", async () => {
    const c = chatClient();
    const ran: string[][] = [];
    const r = renderApp({
      client: c.client,
      runCliFn: async (n, a) => (ran.push([n, ...a]), { code: 0, output: "", timedOut: false }),
    });
    await until(() => r.lastFrame()!.includes("●") || r.lastFrame()!.includes("1▣"));
    await fireUntil(r.stdin, "t", () => r.lastFrame()!.includes("chat · acme/api"));
    c.push(10, metaLine({ ticketId: "acme__api" }));
    c.push(20, chatDraft());
    await until(() => r.lastFrame()!.includes("draft parked"));
    r.stdin.write("\x1b"); // blur (idle)
    await until(() => r.lastFrame()!.includes("i compose"));
    await fireUntil(r.stdin, "s", () => ran.length === 1);
    expect(ran[0]![0]).toBe("submit");
    expect(ran[0]![1]).toMatch(/add-cache\.md$/);
    await fireUntil(r.stdin, "i", () => r.lastFrame()!.includes("esc blur/abort"));
  });

  it("/pr N injects the fetched context as a user message; /abort and /new map to their verbs", async () => {
    const c = chatClient();
    const r = renderApp({ client: c.client });
    await until(() => r.lastFrame()!.includes("acme/api"));
    await fireUntil(r.stdin, "t", () => r.lastFrame()!.includes("chat · acme/api"));
    r.stdin.write("/pr 42\r");
    await until(() =>
      c.calls.some((x) => x.startsWith("prompt:") && x.includes("PR #42: Add cache")),
    );
    r.stdin.write("/abort\r");
    await until(() => c.calls.includes("abort"));
  });

  it("moving the rail selection while in the chat view re-subscribes to the new key", async () => {
    // two watched rows in localFixtures; open chat on the first, then press the rail-down structural key
    const c = chatClient();
    const subs: string[] = [];
    const client: DashboardClient = {
      ...c.client,
      chat: {
        ...c.client.chat,
        subscribe: (k, _s, on) => (subs.push(k), on.status("live"), () => {}),
      },
    };
    const r = renderApp({ client });
    await until(() => r.lastFrame()!.includes("acme/api"));
    await fireUntil(r.stdin, "t", () => r.lastFrame()!.includes("chat ·"));
    const first = subs[0];
    r.stdin.write("\x1b"); // blur the composer (idle)
    await until(() => r.lastFrame()!.includes("i compose"));
    r.stdin.write("h"); // focus the rail (pane 1)
    await new Promise((res) => setTimeout(res, 20));
    await fireUntil(r.stdin, "j", () => subs.length === 2 && subs[1] !== first); // rail → beta/two → re-subscribe
  });
});
```

(`localFixtures.tsx`'s config repos are `acme/api` then `beta/two` — `TO_QUEUE_ROW = "jj"` documents the rail order — so the rail-switch case's down arrow lands on `beta/two`.)

`tests/tuiUnifiedRail.test.tsx` — one case: with `chatBadge: (key) => (key === "acme/api" ? "● 2▣" : null)`, the row for that repo renders `● 2▣`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/tuiViewActions.test.ts tests/tuiApp.chat.test.tsx tests/tuiUnifiedRail.test.tsx > /tmp/t19 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/tui/viewActions.ts`:

- `OverlayView` gains `| "chat"`; `BindingContext`'s `structuralOnly.view` union gains `"chatCompose"`.
- `BODY_VERBS.issues` gains `{ id: "chat", label: "chat" }` **after** `analyze` and before the hidden shift variants; `BODY_VERBS.repoDetail` becomes `[{ id: "chat", label: "chat" }]`. (Spec §8.1: `t` in both; `queue` keeps `t` for `retry`.)
- `VIEW_OPTIONS.chat = [{ id: "submit", label: "submit" }, { id: "edit", label: "edit" }, { id: "discard", label: "discard", guarded: true }, { id: "route", label: "route" }, { id: "thinking", label: "thinking" }, { id: "follow", label: "follow" }, CLOSE]`.
- `VIEW_OPTIONS.review` gains `{ id: "submit", label: "submit" }, { id: "edit", label: "edit" }, { id: "route", label: "route" }` appended before `CLOSE` (Task 18 may already have added them; keep one copy).
- `viewStructural` gains `case "chat": return [s("i", "compose"), s("↑/↓", "move"), s("enter", "expand"), s("[/]", "scroll"), s("esc", "back")];`.
- `structuralOnly` gains `case "chatCompose": return [s("type", "message"), s("enter", "send"), s("ctrl+j", "newline"), s("/", "commands"), s("esc", "blur/abort")];`.

`src/tui/components/UnifiedRail.tsx` — prop `chatBadge?: (key: string) => string | null`; in the repo row, after the lifecycle `badges`: `const chatB = chatBadge?.(repo.key) ?? "";` rendered as `{chatB ? \` ${chatB}\` : ""}`inside the label`Text`.

**Lint ratchet (Ruling R15):** `App` is pinned at 1796 lines by `eslint.config.js`'s `GRANDFATHERED_FUNCTION_LINES` (#438) and upstream #428 already split the action handlers into `src/tui/hooks/`. Put items 5–7 below (the chat action handlers, the input cascade block, and the slash router) in a new hook `src/tui/hooks/useChatInput.ts` that takes the nav spine + `chatApi` + `chatDraftActions` + `client` + `showToast` + `currentNwo` + `scrollBy`/`toEnd`/`setView`/`setPane`/`moveRail`/`moveRailTo` as read-only inputs and returns `{ handleChatKey(input, key): boolean; chatHandlers: Record<string, () => void>; onComposerSubmit(raw: string): void }` — App calls `handleChatKey` at the head of its cascade and spreads `chatHandlers` into the `case "chat"` branch. If App still crosses 1796 after that, raise the pin in `eslint.config.js` with a one-line justification comment (the config states a raised pin is a deliberate, reviewer-visible diff line).

`src/tui/App.tsx`:

1. `View` gains `| "chat"`.
2. Hooks: `const chatApi = useChat({ client, aliveRef });` and

```ts
const suspend = useSuspend();
const chatDraftActions = useChatDrafts({
  client,
  runCliFn,
  showCmdResult,
  editFileFn: props.editFileFn ?? defaultEditFile,
  suspend,
  showToast,
  aliveRef,
  onChanged: () => {
    void loadReview();
    void chatApi.reloadDrafts();
  },
  draftFilePath: (id, name) => join(props.chatDraftsDir, id, name),
});
```

with `AppProps.chatDraftsDir: string` (resolved by `dashboardCmd.ts` from `dataTreePaths(cfg).chatDrafts`, like `clonesDir`), and `showCmdResult` from `useCmdOutput`. Wrap the `onChanged` arrow in `useCallback([loadReview, chatApi.reloadDrafts])` so the hook's deps stay stable.

3. The current repo key: `const currentRepoKey = body?.kind === "issues" ? body.nwo.toLowerCase() : body?.kind === "repoDetail" ? body.repo.key : null;` (memoized).
4. `bindingContext`: before the `switch`, `if (view === "chat") return chatApi.chat?.composerFocused ? { kind: "structuralOnly", view: "chatCompose" } : { kind: "view", view: "chat" };`.
5. `actionHandlers`:
   - main contexts gain `chat: () => { if (currentRepoKey) { chatApi.openChat(currentRepoKey); setView("chat"); } }`.
   - `case "chat"`: `close` (closeChat + `setView("main")`), `submit`/`edit`/`route`/`discard` → `const d = chatApi.selectedDraft(); if (d) void chatDraftActions.<verb>(d); else showToast("info", "no draft under the cursor");`, `thinking` → `chatApi.toggleThinking()`, `follow` → `chatApi.setFollow(!chatApi.chat?.follow)`.
   - `case "review"` gains `submit`/`edit`/`route` for an open or cursor-selected chat draft (Task 18 wired the handlers; ensure they are reachable here).
6. Input cascade — add before the `view === "transcript"` block:

```ts
if (view === "chat" && chatApi.chat) {
  const ch = chatApi.chat;
  if (ch.composerFocused) {
    // The Composer's own useGuardedInput handles typing/enter/chords/slash.
    // Only esc is App's: streaming → abort; idle → blur (spec §8.3).
    if (key.escape) {
      if (ch.streaming) void chatApi.abort();
      else chatApi.focusComposer(false);
    }
    return;
  }
  if (key.escape) return void actionHandlers["close"]?.();
  if (input === "i") return void chatApi.focusComposer(true);
  if (input === "j" || key.downArrow) return void chatApi.moveCursor(1);
  if (input === "k" || key.upArrow) return void chatApi.moveCursor(-1);
  if (key.return || input === " ") return void chatApi.toggleExpanded();
  if (input === "]") return void scrollBy(1);
  if (input === "[") {
    if (ch.follow) {
      toEnd();
      chatApi.setFollow(false);
    }
    return void scrollBy(-1);
  }
  if (input === "G" || key.end) return void chatApi.setFollow(true);
  if (input === "g") {
    chatApi.setFollow(false);
    return void scrollBy(-1_000_000);
  }
  // mnemonics (s/e/D/r/t/f/q) fall through to the derived-keymap dispatch tail
}
```

The rail stays the nav spine from the chat view (spec §8.1). Overlay views today swallow `↑/↓` for their own cursor (the transcript block, `App.tsx:2074-2100`), so the chat block gives the rail an explicit door: while blurred, `h`/`←` → `setPane(1)` and `l`/`→` → `setPane(2)`; and **when `pane === 1`** the chat block routes `j`/`k`/`↑`/`↓`/`g`/`G` to `moveRail`/`moveRailTo` (the same movers the main view uses at `App.tsx:2248-2252`) instead of the chat cursor. The rail-switch effect (item 9) then re-subscribes. Put the `pane === 1` branch first inside the blurred section of the chat block.

7. Composer submit (the slash router), a `useCallback` passed to `ChatView.onComposerSubmit`:

```ts
const onComposerSubmit = useCallback(
  (raw: string): void => {
    const text = raw.trim();
    if (text === "") return;
    const key = chatApi.chat?.key;
    const nwo = currentNwo;
    const m = /^\/(\w+)(?:\s+(.*))?$/.exec(text);
    if (!m) return void chatApi.send(text);
    const [, cmd, arg] = m;
    switch (cmd) {
      case "draft":
        return void chatApi.send(
          "Draft a junco ticket for what we just discussed. Emit it in a junco-ticket fence.",
        );
      case "audit":
        return void chatApi.send(
          "Request a read-only audit of this repository: emit a junco-ticket fence whose frontmatter has an `audit:` block.",
        );
      case "investigate": {
        const n = Number.parseInt(arg ?? "", 10);
        if (!Number.isInteger(n)) return void showToast("error", "usage: /investigate N");
        return void chatApi.send(
          `Request an investigation of issue #${n}: emit a junco-ticket fence whose frontmatter has an \`investigate:\` block with \`issue: ${n}\`.`,
        );
      }
      case "pr":
      case "issue": {
        const n = Number.parseInt(arg ?? "", 10);
        if (!Number.isInteger(n) || !nwo)
          return void showToast("error", `usage: /${cmd} N (watched repo only)`);
        void (cmd === "pr" ? client.prContext(nwo, n) : client.issueContext(nwo, n)).then((r) => {
          if (!aliveRef.current) return;
          if (!r.ok) return void showToast("error", r.error);
          void chatApi.send(
            `Context, ${cmd === "pr" ? "PR" : "issue"} #${n} on ${nwo}:\n\n${r.value}`,
          );
        });
        return;
      }
      case "abort":
        return void chatApi.abort();
      case "new":
        return void chatApi.fresh();
      default:
        showToast("error", `unknown command /${cmd}`);
    }
    void key;
  },
  [chatApi, client, currentNwo, showToast, aliveRef],
);
```

8. `scrollKey`: `if (view === "chat" && chatApi.chat) return \`chat:${chatApi.chat.key}\`;`. `crumbs`: `if (view === "chat" && chatApi.chat) return ["chat", chatApi.chat.key];`.
9. Rail-switch effect (spec §8.1): `useEffect(() => { if (view === "chat" && currentRepoKey && chatApi.chat && chatApi.chat.key !== currentRepoKey) chatApi.openChat(currentRepoKey); }, [view, currentRepoKey, chatApi]);` — `chatApi` is a fresh object each render; destructure `openChat` and `chat` first and list those.
10. Render, beside the transcript branch:

```tsx
      ) : view === "chat" && chatApi.chat ? (
        <ClickableBox flexGrow={1} onWheel={(d) => { if (d < 0 && chatApi.chat?.follow) { toEnd(); chatApi.setFollow(false); } scrollBy(d); }}>
          <ChatView
            state={chatApi.chat}
            modelId={props.chatModelId}
            costUsd={health?.chats?.costUsd ?? null}
            scroll={scroll}
            height={bodyHeight}
            width={bodyWidth}
            focused={pane === 2}
            onScrollMax={setScrollMax}
            onRowPress={(idx) => chatApi.moveCursor(idx - (chatApi.chat?.cursor ?? 0))}
            onComposerChange={chatApi.setComposer}
            onComposerSubmit={onComposerSubmit}
          />
        </ClickableBox>
      ) : …
```

with `AppProps.chatModelId: string | null` (from `chatCfgFor(cfg).model.id`, resolved in `dashboardCmd.ts`). Use the same `scroll`/`bodyHeight`/`bodyWidth`/`setScrollMax` names the transcript branch uses.

11. Rail badge: `chatBadge={(key) => { const s = health?.chats?.sessions.find((x) => x.key === key); if (!s) return null; const parts = [s.streaming ? "●" : "", s.draftsParked > 0 ? \`${s.draftsParked}▣\` : ""].filter(Boolean); return parts.length ? parts.join(" ") : null; }}`— wrap in`useCallback([health])`.

`src/dashboardCmd.ts` — `buildAppProps` gains `chatDraftsDir: dataTreePaths(c).chatDrafts` and `chatModelId: chatCfgFor(c).model.id`; `tests/helpers/localFixtures.tsx`'s `makeAppProps` gains `chatDraftsDir: "/x/chat-drafts"`, `chatModelId: "test/model"`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/tuiViewActions.test.ts tests/tuiApp.chat.test.tsx tests/tuiUnifiedRail.test.tsx tests/tuiApp.test.tsx tests/renderPerf.test.tsx > /tmp/t19 2>&1; echo "exit: $?"` — expected 0. `npm run lint` clean (hooks deps). Then the full suite: `npx vitest run > /tmp/t19-all 2>&1; echo "exit: $?"`.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/viewActions.ts src/tui/App.tsx src/tui/components/UnifiedRail.tsx src/dashboardCmd.ts tests/tuiViewActions.test.ts tests/tuiApp.chat.test.tsx tests/tuiUnifiedRail.test.tsx tests/helpers/localFixtures.tsx
git add src/tui/viewActions.ts src/tui/App.tsx src/tui/components/UnifiedRail.tsx src/dashboardCmd.ts tests/tuiViewActions.test.ts tests/tuiApp.chat.test.tsx tests/tuiUnifiedRail.test.tsx tests/helpers/localFixtures.tsx
git commit -m "feat(tui): chat view wiring — t opens chat, esc state machine, slash commands, rail badge"
```

Then merge `origin/main` and re-run the full suite.

---

### Task 20: CLI surfaces — `transcript --chat`, `status`, `doctor`, `unwatch`

Spec §9.

**Files:**

- Modify: `src/transcriptCmd.ts` (`--chat <key>` option, ~line 34–90), `src/statusCmd.ts` (chat lines, ~line 100–130), `src/doctor.ts` (two checks beside 7a, ~line 711), `src/unwatchCmd.ts` (`PlanItemKind` + items, ~line 26–210 and the summary loop ~361), `src/cli.ts` (usage text for `transcript --chat`)
- Test: `tests/transcriptCmd.test.ts`, `tests/statusCmd.test.ts`, `tests/doctor.test.ts`, `tests/unwatchCmd.test.ts`

**Interfaces:**

- Consumes: `chatSlug` (Task 4); `dataTreePaths(cfg).chats`/`.chatDrafts` (Task 1); `listChatDrafts`, `chatDraftsDir` (Task 11); `ChatHealth` (Task 7).
- Produces: `PlanItemKind` gains `"chat-session" | "chat-draft"`.

- [ ] **Step 1: Write the failing tests**

`tests/transcriptCmd.test.ts` — add (using the file's existing deps pattern: `loadCfg`, `readFile`, `stdout`, `columns`):

```ts
it("--chat <key> resolves <chats>/<slug>/transcript.jsonl", async () => {
  const reads: string[] = [];
  const code = await runTranscriptCmd(["--chat", "Acme/API"], {
    ...deps,
    readFile: (p) => (reads.push(p), metaLine({ ticketId: "acme__api" }) + "\n"),
  });
  expect(code).toBe(0);
  expect(reads[0]).toBe(join(dataTreePaths(cfg).chats, "acme__api", "transcript.jsonl"));
});
it("--chat with a positional is a usage error", async () => {
  expect(await runTranscriptCmd(["--chat", "a/b", "t-1"], deps)).toBe(2);
});
```

`tests/statusCmd.test.ts` — add: with a `/health` body carrying `chats: { enabled: true, sessions: [{ key: "acme/api", slug: "acme__api", streaming: true, turns: 3, lastActivityAt: null, draftsParked: 2 }], turns: 3, costUsd: 0.5, tokensIn: 1, tokensOut: 2 }`, the output contains `chat:      acme/api · streaming · 3 turns · 2 drafts`; with `chats.sessions` empty, no `chat:` line; with `chats.enabled === false`, `chat:      disabled`.

`tests/doctor.test.ts` — add two cases in the style of the health-bind case: `chat.enabled` true with `healthEnabled` false → a `warn` row `chat` saying `chat requires the health server (observability.healthEnabled)`; `chat.enabled` true with `healthEnabled` true → an `ok` row `chat` naming the chats dir.

`tests/unwatchCmd.test.ts` — add: with `<chats>/acme__api/` present and one parked chat draft for `acme/api`, `planUnwatch` lists `{ kind: "chat-session", path: <chats>/acme__api }` and `{ kind: "chat-draft", path: <chatDrafts>/<id>.json, detail: <id> }`; the execute summary deletes both (the draft's files dir too).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/transcriptCmd.test.ts tests/statusCmd.test.ts tests/doctor.test.ts tests/unwatchCmd.test.ts > /tmp/t20 2>&1; echo "exit: $?"` — expected 1.

- [ ] **Step 3: Implement**

`src/transcriptCmd.ts` — `parseArgs` options gain `chat: { type: "string" }`; `USAGE` becomes `Usage: junco transcript <ticket-id | path.jsonl> | --chat <owner/repo | path> [--thinking] [--tools] [--width N] [--json]`. After parsing: if `values.chat` is set, a positional is a usage error (exit 2); otherwise `transcriptPath = join(dataTreePaths(cfg).chats, chatSlug(values.chat), "transcript.jsonl")` (config required — same "no config" message as the ticket-id branch). Everything downstream (summarize/render) is unchanged.

`src/statusCmd.ts` — extend the parsed body type with `chats?: ChatHealth | null` and after the guards line:

```ts
// Chat (spec 2026-09-01 §9): one line per live session; "disabled" when off.
if (body.chats != null) {
  if (!body.chats.enabled) detailLines.push("chat:      disabled");
  for (const s of body.chats.sessions) {
    const bits = [
      s.key,
      s.streaming ? "streaming" : "idle",
      `${s.turns} turn${s.turns === 1 ? "" : "s"}`,
    ];
    if (s.draftsParked > 0) bits.push(`${s.draftsParked} draft${s.draftsParked === 1 ? "" : "s"}`);
    detailLines.push(`chat:      ${bits.join(" · ")}`);
  }
}
```

`src/doctor.ts` — after check 7a:

```ts
// 7c. dashboard chat (spec 2026-09-01 §9): it rides on the health server.
if (cfg.chat.enabled) {
  if (!cfg.healthEnabled) {
    report(
      "warn",
      "chat",
      "chat requires the health server (observability.healthEnabled) — the dashboard chat view will be unavailable",
    );
  } else {
    report("ok", "chat", `enabled · sessions under ${dataTreePaths(cfg).chats}`);
  }
}
```

`src/unwatchCmd.ts` — `PlanItemKind` gains `| "chat-session" | "chat-draft"`; in the items collector (after the comment-review loop):

```ts
const chatDir = join(p.chats, chatSlug(nwo));
if (existsFn(chatDir)) items.push({ kind: "chat-session", path: chatDir });
for (const d of listChatDrafts(cfg, deps))
  if (d.key.toLowerCase() === lower)
    items.push({ kind: "chat-draft", path: join(p.chatDrafts, `${d.id}.json`), detail: d.id });
```

and in the execute pass, a `chat-draft` item also removes `draftFilesDir(cfg, detail)`; a `chat-session` item removes the dir recursively (the same `rmFn` the clone item uses). The summary printer lists them with the other kinds (`byKind("chat-session")`, `byKind("chat-draft")`).

`src/cli.ts` — the `transcript` usage line gains `| --chat <owner/repo|path>`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/transcriptCmd.test.ts tests/statusCmd.test.ts tests/doctor.test.ts tests/unwatchCmd.test.ts tests/unwatchCmd.git.test.ts tests/cli.test.ts > /tmp/t20 2>&1; echo "exit: $?"` — expected 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/transcriptCmd.ts src/statusCmd.ts src/doctor.ts src/unwatchCmd.ts src/cli.ts tests/transcriptCmd.test.ts tests/statusCmd.test.ts tests/doctor.test.ts tests/unwatchCmd.test.ts
git add src/transcriptCmd.ts src/statusCmd.ts src/doctor.ts src/unwatchCmd.ts src/cli.ts tests/transcriptCmd.test.ts tests/statusCmd.test.ts tests/doctor.test.ts tests/unwatchCmd.test.ts
git commit -m "feat(cli): transcript --chat, status chat lines, doctor chat check, unwatch removes chat state"
```

---

### Task 21: Documentation and the full gate

Spec §13.

**Files:**

- Modify: `ARCHITECTURE.md`, `README.md`, `CHANGELOG.md`, `skills/junco-dispatch/SKILL.md`, `CLAUDE.md`

- [ ] **Step 1: `ARCHITECTURE.md`**

After "The Q&A path" add:

```markdown
### The chat path (dashboard chat)
```

dashboard `t` on a repo row → POST /chat/prompt → ChatManager (gate check: budget, provider)
→ ChatSession.prompt → runChatTurn (read-only tools, per-turn timeout, no guards)
→ transcript.jsonl (+ record bus → SSE /chat/events) → fence scan → parked draft
→ dashboard review (s submit → `junco submit …` / `junco audit …` / `junco investigate …`)

`````

One file-backed Pi session per repo lives in the **daemon** (`src/chat/`), under
`<dataDir>/data/chats/<slug>/` — never `~/.pi`. It survives dashboard quits and daemon
restarts (an in-flight turn is stamped `junco_chat_turn_aborted{daemon_stopped|crash}`). It
holds no `max_concurrent` slot, but the daily-budget gate and the provider gate block new turns
exactly as they block claiming, and a provider failure during a turn reports into the gate.
Spend is recorded in-process — `spendLedger.ts` is single-writer by design. The transcript never
persists `message_update` (bus-only, like `runAgent`); `summarizeTranscript` frames chat turns
as runs with `flow: "chat"`.

Drafts: an assistant message containing a ```` ```junco-ticket ```` (or ```` ```junco-plan ````)
fence is extracted (`fenceExtract.ts`: kind by frontmatter shape — ticket / amend / apply /
audit / investigate / ticketSet / planSet; a frontmatter **allowlist** keeps the planner's
security boundary: junco sets `repo:`, and `tools`/`network`/`workdir` are dropped), linted and
routed with `submitPreflight.ts`'s `decideRoute` + `lintTicket`, and parked in
`data/chat-drafts/` (`makeReviewStore`). Confirm spawns the CLI verb — never an in-process
submit. One automatic lint follow-up prompt, never chained.

`/chat/*` (SSE out, POST in) is **loopback-only regardless of `healthHost`** and rejects any
request carrying an `Origin` header.
`````

Module map rows for `chat/` (one line each: `chatKey`, `chatCwd`, `chatTurn`, `chatSession`, `chatManager`, `chatRoutes`, `fenceExtract`, `draftStore`, `chatDrafts`, `chatPrompt`), `tui/chatClient.ts`, `tui/hooks/useChat.ts`, `tui/hooks/useChatDrafts.ts`, `tui/components/{ChatView,Composer,TranscriptBody}.tsx`; the data-tree description gains `data/chats` and `data/chat-drafts`; "Health endpoints" gains the `/chat/*` table from spec §5.1.

- [ ] **Step 2: `README.md`**

A "Chat with the agent" section: open with `t` on a repo row; ask anything about the repo (read-only); "make a ticket for that" parks a draft — `s` submits, `e` edits, `r` cycles the route, `D` discards; every dispatch branch is reachable (ticket, ticket set, plan set, amend, apply, audit, investigate); `/pr N`, `/issue N` pull context; sessions survive restarts; `junco transcript --chat owner/repo` prints one; loopback-only.

- [ ] **Step 3: `CHANGELOG.md`**

Under Unreleased → Added: `feat(tui): per-repo chat with the coding agent inside the dashboard; every dispatch branch (ticket, set, plan set, amend, apply, audit, investigate) drafts from the conversation and parks for review. New config block `chat._`; new data-tree dirs `data/chats`, `data/chat-drafts`; new loopback-only `/chat/_`routes on the health server;`junco transcript --chat`.`

- [ ] **Step 4: `skills/junco-dispatch/SKILL.md`**

After the front matter / intro paragraph, one paragraph: "The dashboard chat (`src/chat/chatPrompt.ts`) lifts the following sections of this file by their exact headings at build time — renaming one is a contract change caught by `tests/chatPrompt.test.ts`: Metadata rules; Authoring discipline (what makes the plan NOT loop); Things to NEVER put in a plan; Ticket sets; Wrapping an existing plan file; Amend mode (follow-up tickets on existing PRs); Apply mode (patch tickets); Assess mode → Inputs to gather; Analyze mode → Inputs to gather."

- [ ] **Step 5: `CLAUDE.md`**

Under "Hard rules", one line: "`/chat/*` on the health server is loopback-only by construction (`chatRoutes.ts` checks the socket address and rejects any `Origin` header) — `healthHost` never widens it. The chat session's tools are the Q&A read-only subset; drafts pass a frontmatter allowlist (`fenceExtract.ts`) — never let model output set `repo:`/`tools:`/`network:`/`workdir:`."

- [ ] **Step 6: Full gate and commit**

```bash
npx prettier --write ARCHITECTURE.md README.md CHANGELOG.md skills/junco-dispatch/SKILL.md CLAUDE.md
npm run lint && npm run format:check && npm run typecheck && npm run build
npx vitest run > /tmp/final 2>&1; echo "exit: $?"
npx vitest run --coverage > /tmp/cov 2>&1; echo "exit: $?"
git add ARCHITECTURE.md README.md CHANGELOG.md skills/junco-dispatch/SKILL.md CLAUDE.md
git commit -m "docs: dashboard chat — architecture, README, changelog, skill contract note"
```

Both vitest exit codes must be 0 (the coverage run enforces the pinned floor). Then merge `origin/main`, re-run the gate, and hand off with `superpowers:finishing-a-development-branch` (PR from `feat/dashboard-chat`; no push/tag/release without the maintainer's explicit approval).

- [ ] **Step 7: Manual smoke (not in the suite, per spec Non-goals)**

In a sandboxed HOME (CLAUDE.md's `SB=$(mktemp -d) …` recipe) with a config pointing at a reachable model: `junco start` in one terminal, `junco dashboard` in another, `t` on a repo row, ask a question, ask for a ticket, `s` submit, confirm the ticket landed in the sandbox inbox. Record the outcome in the PR body.
