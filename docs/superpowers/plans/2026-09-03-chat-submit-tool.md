# Chat submit tool — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard chat's model gets one custom tool, `junco_submit`, that submits an already-parked draft after the operator confirms in the dashboard — synchronously inside the model's turn — plus a `/submit` composer shortcut.

**Architecture:** A plain-object SDK tool definition (`src/chat/submitTool.ts`) whose `execute` writes a `junco_chat_command{proposed}` record and blocks on a promise the session resolves when `POST /chat/decide` arrives; the turn's timeout is a pausable `TurnDeadline`; the confirmed submit spawns the real CLI through a shared spawner. The dashboard derives a `pending` confirmation from the records, renders a card, and answers with `y`/`n`.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM), Pi SDK custom tools (`customTools` + name allowlist), Ink 7 / React 19, vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-chat-submit-tool-design.md`

## Global Constraints

- Never import the Pi SDK at module top level in `src/` outside `src/agent/session.ts`; the tool definition is a plain object cast at that single boundary (`as never`), like the sandbox tools.
- Every side effect behind a deps seam: `spawnFn`/`cliPath` for the CLI, `ReviewStoreDeps` for the draft store, `now` for clocks. Tests never spawn the real CLI.
- The chat's file tools stay `READ_ONLY_TOOLS`; `readOnly: true` stays; the only new capability is `junco_submit`.
- `/chat/decide` sits behind the same loopback + Host + Origin boundary as every `/chat/*` route.
- `src/tui/**` runs both react-hooks rules at error; App's `max-lines-per-function` ratchet is 1880 (`eslint.config.js`) — bump only with an itemised comment.
- Ink tests loop-until-condition (`tests/helpers/until.ts`), never a fixed tick. A multi-char `stdin.write` is ONE chunk.
- A new `Config` leaf goes into `tests/helpers/config.ts`'s literal, `src/configLevers.ts`, `tests/configLevers.test.ts`'s flat-key map, `src/configAssemble.ts`, `src/types.ts`, `docs/configuration.md`.
- Conventional commits, no AI attribution trailers, suite green at every commit; `npx prettier --write` on touched files before each commit.
- Full gate before the PR: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test && npm run test:e2e`.

---

### Task 1: The `junco_chat_command` record, its summary note, anchor, and rows

**Files:**

- Modify: `src/agent/transcriptSchema.ts` (after `ChatDraftRecord`, ~line 130; the `ChatRecord` union ~line 141)
- Modify: `src/transcriptSummary.ts` (`ChatNote` ~line 68; reducer `case "junco_chat_draft"` ~line 288; `draftAnchor`/`anchorIds` ~line 410)
- Modify: `src/transcriptRender.ts` (`case "draft"` ~line 284)
- Test: `tests/transcriptSummary.test.ts`, `tests/transcriptRender.test.ts`

**Interfaces:**

- Produces: `ChatCommandRecord` (schema), `ChatNote` variant `{ kind: "command", … }`, `commandAnchor(id) => "cmd:<id>"`, rendered rows per status, expandable output under `o.expanded.has(commandAnchor(id))`.

- [ ] **Step 1: Write the failing summary test**

Append to `tests/transcriptSummary.test.ts` (import `commandAnchor` and `anchorIds` from `../src/transcriptSummary.js`; the file already imports `summarizeTranscript` and the chat fixtures):

```ts
describe("junco_chat_command", () => {
  const cmd = (over: Record<string, unknown>): string =>
    JSON.stringify({
      type: "junco_chat_command",
      commandId: "call_1",
      command: "submit",
      draftId: "acme__api-20260903-1",
      ids: ["add-readme"],
      route: "inbox",
      status: "proposed",
      exitCode: null,
      output: null,
      detail: null,
      ts: "2026-09-03T10:00:00.000Z",
      ...over,
    });

  it("a proposed command is a note with an anchor; its terminal record REPLACES it in place", () => {
    const s = summarizeTranscript([metaLine(), chatPrompt(), chatTurnStart(), cmd({})]);
    const run = s.runs[0]!;
    expect(run.notes).toHaveLength(1);
    expect(run.notes[0]).toMatchObject({
      kind: "command",
      status: "proposed",
      ids: ["add-readme"],
    });
    expect(anchorIds(s)).toEqual([commandAnchor("call_1")]);

    const done = summarizeTranscript([
      metaLine(),
      chatPrompt(),
      chatTurnStart(),
      cmd({}),
      cmd({ status: "ran", exitCode: 0, output: "queued add-readme\n" }),
    ]);
    expect(done.runs[0]!.notes).toHaveLength(1);
    expect(done.runs[0]!.notes[0]).toMatchObject({ kind: "command", status: "ran", exitCode: 0 });
    expect(anchorIds(done)).toEqual([commandAnchor("call_1")]);
  });

  it("a terminal record for an UNKNOWN command id is kept as its own note (forward compat)", () => {
    const s = summarizeTranscript([
      metaLine(),
      chatPrompt(),
      chatTurnStart(),
      cmd({ commandId: "call_9", status: "expired", detail: "daemon restarted" }),
    ]);
    expect(s.runs[0]!.notes).toHaveLength(1);
    expect(s.runs[0]!.notes[0]).toMatchObject({ status: "expired", detail: "daemon restarted" });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/transcriptSummary.test.ts`
Expected: FAIL — `commandAnchor` is not exported; notes are empty.

- [ ] **Step 3: Add the record, the note, the anchor**

`src/agent/transcriptSchema.ts`, after `ChatDraftRecord`:

```ts
/** The chat's one action tool (spec 2026-09-03): a `junco_submit` call is
 * PROPOSED (the operator's card), then settled by exactly one terminal
 * record with the same `commandId` — the SDK's toolCallId. */
export interface ChatCommandRecord {
  type: "junco_chat_command";
  commandId: string;
  command: "submit";
  draftId: string;
  /** The draft's ticket ids (file stems), for the row. */
  ids: string[];
  /** Effective destination for this submission. */
  route: "inbox" | "issue";
  status: "proposed" | "ran" | "failed" | "declined" | "expired" | "aborted";
  /** ran/failed only. */
  exitCode: number | null;
  /** ran/failed only; the CLI's merged output, ≤ 4 KiB tail. */
  output: string | null;
  /** Human context — "no decision in 10m", "daemon restarted", "draft no longer parked". */
  detail: string | null;
  ts: string;
}
```

and add `| ChatCommandRecord` to `ChatRecord`.

`src/transcriptSummary.ts` — import the type, extend `ChatNote`:

```ts
  | {
      kind: "command";
      commandId: string;
      command: "submit";
      draftId: string;
      ids: string[];
      route: "inbox" | "issue";
      status: ChatCommandRecord["status"];
      exitCode: number | null;
      output: string | null;
      detail: string | null;
      ts: string;
    }
```

reducer, after `case "junco_chat_draft"`:

```ts
        case "junco_chat_command": {
          const note: ChatNote = {
            kind: "command",
            commandId: r.commandId,
            command: r.command,
            draftId: r.draftId,
            ids: r.ids,
            route: r.route,
            status: r.status,
            exitCode: r.exitCode,
            output: r.output,
            detail: r.detail,
            ts: r.ts,
          };
          // One row per command: the terminal record replaces the proposed
          // one wherever it sits (the daemon-restart `expired` stamp lands
          // before any new run opens, so the proposal may be in an earlier run).
          const replaced = out.runs.some((run) => {
            const i = run.notes.findIndex(
              (n) => n.kind === "command" && n.commandId === r.commandId,
            );
            if (i === -1) return false;
            run.notes[i] = note;
            return true;
          });
          if (!replaced) noteRun().notes.push(note);
          break;
        }
```

(`openRun` pushes a run onto `out.runs` the moment it opens — `src/transcriptSummary.ts:191` — so the open run is searched too.)

anchors:

```ts
export const commandAnchor = (commandId: string): string => `cmd:${commandId}`;
export function anchorIds(s: TranscriptSummary): string[] {
  const out: string[] = [];
  for (const r of s.runs) {
    for (const t of r.turns) for (const c of t.toolCalls) out.push(c.id);
    for (const n of r.notes) {
      if (n.kind === "draft") out.push(draftAnchor(n.draftId));
      else if (n.kind === "command") out.push(commandAnchor(n.commandId));
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the summary test**

Run: `npx vitest run tests/transcriptSummary.test.ts` — Expected: PASS.

- [ ] **Step 5: Write the failing render test**

Append to `tests/transcriptRender.test.ts` (reuse the `cmd` helper shape above; import `commandAnchor`):

```ts
describe("junco_chat_command rows", () => {
  const lines = (over: Record<string, unknown>, expanded: string[] = []) => {
    const s = summarizeTranscript([
      metaLine(),
      chatPrompt(),
      chatTurnStart(),
      JSON.stringify({
        type: "junco_chat_command",
        commandId: "call_1",
        command: "submit",
        draftId: "d1",
        ids: ["add-readme"],
        route: "inbox",
        status: "proposed",
        exitCode: null,
        output: null,
        detail: null,
        ts: "2026-09-03T10:00:00.000Z",
        ...over,
      }),
    ]);
    return renderTranscriptRows(s, opts({ width: 100, expanded: new Set(expanded) }));
  };
  const row = (rows: ReturnType<typeof lines>) =>
    rows.find((r) => r.anchor === commandAnchor("call_1"))!;

  it("renders one row per status, anchored, in the spec's tone", () => {
    expect(row(lines({}))).toMatchObject({
      text: "   ▸ submit add-readme → inbox — awaiting you · y submit · n keep parked",
      tone: "accent",
    });
    expect(row(lines({ status: "ran", exitCode: 0, output: "ok" }))).toMatchObject({
      text: "   ✓ submitted → inbox · add-readme · exit 0",
      tone: "success",
    });
    expect(row(lines({ status: "failed", exitCode: 1, output: "boom" }))).toMatchObject({
      text: "   ✗ submit failed · exit 1 · add-readme — draft stays parked",
      tone: "error",
    });
    expect(row(lines({ status: "declined" }))).toMatchObject({ tone: "dim" });
    expect(row(lines({ status: "expired", detail: "no decision in 10m" })).text).toBe(
      "   ⌛ submit expired · no decision in 10m · draft stays parked",
    );
    expect(row(lines({ status: "aborted" })).text).toContain("aborted with the turn");
  });

  it("expands the CLI output under a ran/failed row, dim and indented", () => {
    const rows = lines({ status: "ran", exitCode: 0, output: "queued add-readme\ninbox: 1" }, [
      commandAnchor("call_1"),
    ]);
    const at = rows.findIndex((r) => r.anchor === commandAnchor("call_1"));
    expect(rows[at + 1]).toEqual({ text: "      queued add-readme", tone: "dim" });
    expect(rows[at + 2]).toEqual({ text: "      inbox: 1", tone: "dim" });
    // Not expanded → no output rows.
    expect(
      lines({ status: "ran", exitCode: 0, output: "x" }).some((r) => r.text.includes("      x")),
    ).toBe(false);
  });
});
```

- [ ] **Step 6: Render the rows**

`src/transcriptRender.ts`, after `case "draft": { … }` — import `commandAnchor` and `ChatCommandRecord`:

```ts
        case "command": {
          const what = n.ids.join(", ") || n.draftId;
          const anchor = commandAnchor(n.commandId);
          const rows: Record<ChatCommandRecord["status"], [string, RowTone]> = {
            proposed: [
              `   ▸ submit ${what} → ${n.route} — awaiting you · y submit · n keep parked`,
              "accent",
            ],
            ran: [`   ✓ submitted → ${n.route} · ${what} · exit ${n.exitCode ?? "?"}`, "success"],
            failed: [
              `   ✗ submit failed · exit ${n.exitCode ?? "?"} · ${what} — draft stays parked`,
              "error",
            ],
            declined: [`   – submit declined · ${what} · draft stays parked`, "dim"],
            expired: [
              `   ⌛ submit expired · ${n.detail ?? "no decision"} · draft stays parked`,
              "warn",
            ],
            aborted: [`   – submit aborted with the turn · ${what} · draft stays parked`, "dim"],
          };
          const [text, tone] = rows[n.status];
          push(truncate(text, width), tone, anchor);
          if (o.expanded.has(anchor) && n.output !== null) {
            const body = n.output === "" ? ["(no output)"] : n.output.split("\n");
            for (const raw of body.slice(0, TOOL_BODY_MAX_LINES))
              for (const l of wrapText(raw, width - 6)) push(`      ${l}`, "dim");
          }
          break;
        }
```

- [ ] **Step 7: Run both files, then commit**

Run: `npx vitest run tests/transcriptSummary.test.ts tests/transcriptRender.test.ts` — Expected: PASS.

```bash
npx prettier --write src/agent/transcriptSchema.ts src/transcriptSummary.ts src/transcriptRender.ts tests/transcriptSummary.test.ts tests/transcriptRender.test.ts
git add -A && git commit -m "feat(chat): junco_chat_command record, summary note, anchor and rows"
```

---

### Task 2: Config levers `chat.submitTool` and `chat.confirmTimeoutMinutes`

**Files:**

- Modify: `src/configSchema.ts` (chat block ~line 246), `src/types.ts` (`ChatConfig` ~line 108), `src/configAssemble.ts` (~line 241), `src/configLevers.ts` (after `chat.turnTimeoutMinutes` ~line 848), `tests/helpers/config.ts` (line 146), `tests/configLevers.test.ts` (flat-key map ~line 330), `docs/configuration.md` (§ Chat table)
- Test: `tests/configLevers.test.ts` (existing invariants), `tests/config.test.ts` (defaults)

**Interfaces:**

- Produces: `cfg.chat.submitTool: boolean` (default `true`), `cfg.chat.confirmTimeoutMinutes: number` (default `10`).

- [ ] **Step 1: Write the failing default test**

In `tests/config.test.ts` (find the existing "defaults" case for the chat block, or add):

```ts
it("chat.submitTool defaults on and chat.confirmTimeoutMinutes to 10", () => {
  const parsed = ConfigSchema.parse({});
  expect(parsed.chat.submitTool).toBe(true);
  expect(parsed.chat.confirmTimeoutMinutes).toBe(10);
});
```

- [ ] **Step 2: Run it** — `npx vitest run tests/config.test.ts tests/configLevers.test.ts` — Expected: FAIL (unknown property / lever-per-leaf invariant).

- [ ] **Step 3: Add the leaves everywhere the constraint lists**

`src/configSchema.ts`:

```ts
  chat: z
    .object({
      enabled: z.boolean().default(true),
      modelId: z.string().min(1).optional(),
      thinkingLevel: z.string().min(1).optional(),
      turnTimeoutMinutes: z.number().min(1).optional(),
      submitTool: z.boolean().default(true),
      confirmTimeoutMinutes: z.number().min(1).default(10),
    })
    .prefault({}),
```

`src/types.ts` `ChatConfig`: add

```ts
/** Register `junco_submit` on new chat sessions (spec 2026-09-03). */
submitTool: boolean;
/** How long a proposed submit waits for the operator's y/n before expiring. */
confirmTimeoutMinutes: number;
```

`src/configAssemble.ts`: `submitTool: d.chat.submitTool, confirmTimeoutMinutes: d.chat.confirmTimeoutMinutes,`.

`src/configLevers.ts`, after the `chat.turnTimeoutMinutes` entry:

```ts
  {
    path: "chat.submitTool",
    type: "boolean",
    default: true,
    editable: true,
    reload: "restart",
    description:
      "Register the junco_submit tool on new chat sessions (the model can submit a parked draft after you confirm).",
  },
  {
    path: "chat.confirmTimeoutMinutes",
    type: "number",
    default: 10,
    min: 1,
    editable: true,
    reload: "restart",
    description: "How long a proposed chat submit waits for y/n in the dashboard before expiring.",
  },
```

`tests/helpers/config.ts` line 146: `chat: { enabled: true, modelId: null, thinkingLevel: null, turnTimeoutMinutes: null, submitTool: true, confirmTimeoutMinutes: 10 },`

`tests/configLevers.test.ts` flat map: `"chat.submitTool": ["chat.submitTool"], "chat.confirmTimeoutMinutes": ["chat.confirmTimeoutMinutes"],`

`docs/configuration.md` § Chat table, two rows:

```
| `chat.submitTool`            | `true`  | restart | Register the `junco_submit` tool on new chat sessions, so "submit it" in the chat proposes the parked draft for your `y`/`n` (see [Dashboard § chat](dashboard.md)). `false` keeps the model drafting only. |
| `chat.confirmTimeoutMinutes` | `10`    | restart | How long a proposed submit waits for your decision before it expires and the draft stays parked.                                                                                                          |
```

- [ ] **Step 4: Run** — `npx vitest run tests/config.test.ts tests/configLevers.test.ts tests/docs*.test.ts` — Expected: PASS; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/configSchema.ts src/types.ts src/configAssemble.ts src/configLevers.ts tests/helpers/config.ts tests/configLevers.test.ts tests/config.test.ts docs/configuration.md
git add -A && git commit -m "feat(config): chat.submitTool and chat.confirmTimeoutMinutes"
```

---

### Task 3: Shared pieces the daemon and the dashboard both use — `spawnCli`, `submitArgv`, `findChatDraft`

**Files:**

- Create: `src/cliSpawn.ts` (the spawn core lifted out of `src/tui/cliRunner.ts:97-140`)
- Modify: `src/tui/cliRunner.ts` (`runCliCommand` delegates to `spawnCli`; keeps `PALETTE_COMMANDS`, `timeoutFor`, the `CliRunResult`/`CliRunnerDeps` types — re-exported from `cliSpawn.ts`)
- Create: `src/chat/submitArgv.ts` (moved verbatim from `src/tui/hooks/useChatDrafts.ts:18-36`, with `nextRoute` staying in the hook)
- Modify: `src/tui/hooks/useChatDrafts.ts` (import + re-export `submitArgv` from `../../chat/submitArgv.js` so `tests/useChatDrafts.test.tsx` keeps its import)
- Modify: `src/chat/draftStore.ts` (add `findChatDraft`)
- Test: `tests/cliSpawn.test.ts`, `tests/draftStore.test.ts` (or the existing draft-store suite), `tests/tuiCliRunner.test.ts` (existing; must still pass)

**Interfaces:**

- Produces: `spawnCli(argv: string[], deps?: CliRunnerDeps): Promise<CliRunResult>` — `argv[0]` is the subcommand; resolves ALWAYS.
- Produces: `submitArgv(d: PendingDraft, filePath: (name: string) => string): string[][]` (unchanged signature, new home).
- Produces: `findChatDraft(cfg, key, ref: string | undefined, deps?): DraftLookup` where `type DraftLookup = { ok: true; draft: PendingDraft } | { ok: false; reason: "none" | "unknown" | "ambiguous"; candidates: PendingDraft[] }`.
- Produces: `draftTicketIds(d: PendingDraft): string[]` — `d.files.map((f) => f.name.replace(/\.md$/, ""))`, the `ids` the dashboard already computes inline in `useChatDrafts.ts`.

- [ ] **Step 1: Failing test for `spawnCli`**

`tests/helpers/fakeSpawn.ts` (shared with Task 5's executor test):

```ts
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

/** A ChildProcess-shaped fake: `script` drives stdout/stderr/close on the
 * next tick. `calls` records each spawn's argv (the cli path first). */
export class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string | null = null;
  kill(sig: string): boolean {
    this.killed = sig;
    this.emit("close", null);
    return true;
  }
}

export function fakeSpawn(script: (child: FakeChild) => void): {
  spawnFn: typeof spawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const spawnFn = ((_exe: string, args: string[]) => {
    calls.push(args);
    const child = new FakeChild();
    setTimeout(() => script(child), 1);
    return child;
  }) as unknown as typeof spawn;
  return { spawnFn, calls };
}
```

`tests/cliSpawn.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { spawnCli } from "../src/cliSpawn.js";
import { fakeSpawn } from "./helpers/fakeSpawn.js";

describe("spawnCli", () => {
  it("spawns node <cliPath> <argv> and merges stdout+stderr into output", async () => {
    const { spawnFn, calls } = fakeSpawn((c) => {
      c.stdout.emit("data", Buffer.from("queued\n"));
      c.stderr.emit("data", Buffer.from("warn\n"));
      c.emit("close", 0);
    });
    const r = await spawnCli(["submit", "/d/t.md"], { spawnFn, cliPath: "/dist/cli.js" });
    expect(calls[0]).toEqual(["/dist/cli.js", "submit", "/d/t.md"]);
    expect(r).toEqual({ code: 0, output: "queued\nwarn\n", timedOut: false });
  });

  it("times out with SIGKILL and code null", async () => {
    const { spawnFn } = fakeSpawn(() => {});
    const r = await spawnCli(["status"], { spawnFn, cliPath: "/dist/cli.js", timeoutMs: 20 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run tests/cliSpawn.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Extract the spawner**

`src/cliSpawn.ts`:

```ts
/**
 * The one way junco runs its own CLI from inside a process: argv arrays only
 * (no shell, no injection surface), merged stdout+stderr, a hard timeout,
 * and a promise that ALWAYS resolves. Shared by the dashboard's command
 * palette (src/tui/cliRunner.ts) and the daemon's chat submit tool
 * (src/chat/submitExec.ts) — the daemon never imports from src/tui.
 * No --config is threaded through: the child inherits the environment and
 * resolves the same canonical ~/.junco/config.json itself.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface CliRunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export interface CliRunnerDeps {
  spawnFn?: typeof spawn;
  cliPath?: string;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

// From dist/cliSpawn.js, ./cli.js is dist/cli.js — the shipped entry. (Tests
// always inject cliPath; the default only runs in a built tree.)
const DEFAULT_CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));

/** Run `junco <argv>`; resolves ALWAYS (errors land in `output`). */
export function spawnCli(argv: string[], deps: CliRunnerDeps = {}): Promise<CliRunResult> {
  const spawnFn = deps.spawnFn ?? spawn;
  const cliPath = deps.cliPath ?? DEFAULT_CLI_PATH;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolvePromise) => {
    const chunks: string[] = [];
    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(process.execPath, [cliPath, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolvePromise({ code: null, output: String((e as Error).message ?? e), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: timedOut ? null : code, output: chunks.join(""), timedOut });
    };
    child.stdout?.on("data", (d: Buffer) => chunks.push(d.toString()));
    child.stderr?.on("data", (d: Buffer) => chunks.push(d.toString()));
    child.on("close", (code: number | null) => settle(code));
    child.on("error", (e: Error) => {
      chunks.push(String(e.message ?? e));
      settle(null);
    });
  });
}
```

`src/tui/cliRunner.ts`: delete its copy of `CliRunResult`, `CliRunnerDeps`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_CLI_PATH` and the body of `runCliCommand`; keep the roster and:

```ts
import {
  spawnCli,
  DEFAULT_TIMEOUT_MS,
  type CliRunResult,
  type CliRunnerDeps,
} from "../cliSpawn.js";
export { DEFAULT_TIMEOUT_MS, type CliRunResult, type CliRunnerDeps };

/** Run one palette subcommand with the roster's time budget; resolves ALWAYS. */
export function runCliCommand(
  name: string,
  extraArgs: string[],
  deps: CliRunnerDeps = {},
): Promise<CliRunResult> {
  return spawnCli([name, ...extraArgs], { ...deps, timeoutMs: deps.timeoutMs ?? timeoutFor(name) });
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/cliSpawn.test.ts tests/tuiCliRunner.test.ts` — Expected: PASS (the existing runner suite injects `cliPath`; nothing observable changed).

- [ ] **Step 5: Move `submitArgv`; add `draftTicketIds` and `findChatDraft`**

`src/chat/submitArgv.ts` — the exact function from `useChatDrafts.ts:14-36` (comment included) plus:

```ts
/** The ticket ids a draft carries — its file stems; what the card and the
 * `junco_chat_draft`/`junco_chat_command` records show as `ids`. */
export function draftTicketIds(d: PendingDraft): string[] {
  return d.files.map((f) => f.name.replace(/\.md$/, ""));
}
```

`src/tui/hooks/useChatDrafts.ts`: `import { submitArgv, draftTicketIds } from "../../chat/submitArgv.js"; export { submitArgv };` and use `draftTicketIds(d)` where the hook builds `ids` (line ~127).

`src/chat/draftStore.ts`, after `draftsParkedFor`:

```ts
export type DraftLookup =
  | { ok: true; draft: PendingDraft }
  | { ok: false; reason: "none" | "unknown" | "ambiguous"; candidates: PendingDraft[] };

/** Resolve the draft a chat verb names (spec 2026-09-03 §3.1): a draft id,
 * or a ticket id (the file stem). No `ref` → the ONLY parked draft of this
 * chat; two or more → ambiguous, the caller must name one. Scoped to `key`,
 * so a chat can never touch another repo's draft. */
export function findChatDraft(
  cfg: Config,
  key: string,
  ref: string | undefined,
  deps: ReviewStoreDeps = {},
): DraftLookup {
  const mine = listChatDrafts(cfg, deps).filter((d) => d.key === key);
  if (mine.length === 0) return { ok: false, reason: "none", candidates: [] };
  if (ref === undefined) {
    return mine.length === 1
      ? { ok: true, draft: mine[0]! }
      : { ok: false, reason: "ambiguous", candidates: mine };
  }
  const hit = mine.filter(
    (d) => d.id === ref || d.files.some((f) => f.name === ref || f.name === `${ref}.md`),
  );
  if (hit.length === 1) return { ok: true, draft: hit[0]! };
  return hit.length === 0
    ? { ok: false, reason: "unknown", candidates: mine }
    : { ok: false, reason: "ambiguous", candidates: hit };
}
```

Tests (in the draft-store suite — `tests/draftStore.test.ts` if present, else `tests/chatDrafts.test.ts` — with two written drafts for `acme/api` and one for `beta/two`, using the suite's existing `writeChatDraft` fixtures):

```ts
it("findChatDraft: by draft id, by ticket id, only-one, ambiguous, unknown, key-scoped", () => {
  expect(findChatDraft(cfg, "acme/api", "acme__api-1")).toMatchObject({ ok: true });
  expect(findChatDraft(cfg, "acme/api", "add-readme")).toMatchObject({
    ok: true,
    draft: { id: "acme__api-1" },
  });
  expect(findChatDraft(cfg, "acme/api", undefined)).toMatchObject({
    ok: false,
    reason: "ambiguous",
  });
  expect(findChatDraft(cfg, "beta/two", undefined)).toMatchObject({ ok: true });
  expect(findChatDraft(cfg, "acme/api", "nope")).toMatchObject({ ok: false, reason: "unknown" });
  expect(findChatDraft(cfg, "acme/api", "beta-ticket")).toMatchObject({
    ok: false,
    reason: "unknown",
  });
});
```

- [ ] **Step 6: Run** — `npx vitest run tests/useChatDrafts.test.tsx tests/draftStore.test.ts tests/chatDrafts.test.ts` — Expected: PASS; `npm run typecheck` clean.

- [ ] **Step 7: Commit**

```bash
npx prettier --write src/cliSpawn.ts src/tui/cliRunner.ts src/chat/submitArgv.ts src/tui/hooks/useChatDrafts.ts src/chat/draftStore.ts tests/cliSpawn.test.ts tests/draftStore.test.ts
git add -A && git commit -m "refactor(chat): share the CLI spawner, submitArgv and a draft lookup between daemon and dashboard"
```

---

### Task 4: `TurnDeadline` — a pausable per-turn timeout

**Files:**

- Modify: `src/chat/chatTurn.ts` (export `TurnDeadline`; `ChatTurnOpts.deadline?: TurnDeadline`; `runChatTurn` arms it instead of its own `setTimeout`)
- Test: `tests/chatTurn.test.ts`

**Interfaces:**

- Produces: `class TurnDeadline { constructor(ms: number, now?: () => number); arm(onFire: () => void): void; pause(): void; resume(): void; clear(): void; readonly remainingMs: number; readonly paused: boolean }`.
- Consumes: nothing new. Task 5 constructs one per turn and pauses it while a confirmation is pending.

- [ ] **Step 1: Failing tests**

Append to `tests/chatTurn.test.ts` (import `TurnDeadline`):

```ts
describe("TurnDeadline", () => {
  it("fires after ms, minus nothing when never paused", async () => {
    let fired = 0;
    const d = new TurnDeadline(20);
    d.arm(() => fired++);
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(1);
  });

  it("a paused span does not count: pause/resume defers the fire by the pause length", async () => {
    let t = 0;
    const now = () => t;
    let fired = 0;
    const d = new TurnDeadline(100, now);
    d.arm(() => fired++);
    t = 40;
    d.pause();
    expect(d.remainingMs).toBe(60);
    expect(d.paused).toBe(true);
    t = 10_000; // an hour with the operator
    d.resume();
    expect(d.remainingMs).toBe(60);
    expect(fired).toBe(0);
    d.clear();
  });

  it("runChatTurn with a paused deadline does not time out; resuming it does", async () => {
    const s = await fakeChatSession([{ events: [], delayMs: 10_000 }])();
    const deadline = new TurnDeadline(30);
    deadline.pause();
    const p = runChatTurn(s, {
      text: "slow",
      timeoutMs: 30,
      emit: () => {},
      abortGraceMs: 20,
      deadline,
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(s.aborted).toBe(0); // still paused → no timeout fired
    deadline.resume();
    const r = await p;
    expect(r.abortReason).toBe("timeout");
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run tests/chatTurn.test.ts` — Expected: FAIL (no export).

- [ ] **Step 3: Implement**

`src/chat/chatTurn.ts`:

```ts
/**
 * The per-turn timeout as a PAUSABLE deadline (spec 2026-09-03 §3.3): while a
 * `junco_submit` call waits for the operator's y/n the clock stops, so a slow
 * human never trips the turn's 30-minute budget — the confirmation has its own.
 * Arithmetic, not wall-clock: `remaining` shrinks only by armed spans.
 */
export class TurnDeadline {
  private remaining: number;
  private armedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onFire: (() => void) | null = null;
  private isPaused = false;

  constructor(
    ms: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.remaining = ms;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get remainingMs(): number {
    return this.armedAt === null
      ? this.remaining
      : Math.max(0, this.remaining - (this.now() - this.armedAt));
  }

  arm(onFire: () => void): void {
    this.onFire = onFire;
    if (!this.isPaused) this.start();
  }

  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.stop();
  }

  resume(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    if (this.onFire !== null) this.start();
  }

  clear(): void {
    this.stop();
    this.onFire = null;
  }

  private start(): void {
    this.armedAt = this.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.armedAt = null;
      this.remaining = 0;
      this.onFire?.();
    }, this.remaining);
  }

  private stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.armedAt !== null) {
      this.remaining = Math.max(0, this.remaining - (this.now() - this.armedAt));
      this.armedAt = null;
    }
  }
}
```

`ChatTurnOpts` gains `/** Session-owned so the submit tool can pause it; absent → a private one. */ deadline?: TurnDeadline;`. In `runChatTurn`, replace `const timer = setTimeout(() => softAbort("timeout"), opts.timeoutMs);` with:

```ts
const deadline = opts.deadline ?? new TurnDeadline(opts.timeoutMs, now);
deadline.arm(() => softAbort("timeout"));
```

and in the `finally`, replace `clearTimeout(timer);` with `deadline.clear();`.

- [ ] **Step 4: Run** — `npx vitest run tests/chatTurn.test.ts tests/chatSession.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/chat/chatTurn.ts tests/chatTurn.test.ts
git add -A && git commit -m "feat(chat): TurnDeadline — a pausable per-turn timeout"
```

---

### Task 5: The tool, the executor, and the session handshake

**Files:**

- Create: `src/chat/submitTool.ts`, `src/chat/submitExec.ts`
- Modify: `src/agent/session.ts` (`SessionOverrides.customTools`; `makePiSessionFactory` merges custom tools ~line 907)
- Modify: `src/chat/chatSession.ts` (deps, tool build in `ensureSession`, `turn_start.tools`, `TurnDeadline` per turn, pending-confirm state, `decide`, `abort`, `stampCrashIfNeeded`)
- Modify: `src/chat/chatManager.ts` (`decide`)
- Test: `tests/submitTool.test.ts`, `tests/submitExec.test.ts`, `tests/chatSession.test.ts`, `tests/chatManager.test.ts`, `tests/sessionOverrides.test.ts` (or wherever `makePiSessionFactory`'s overrides are pinned — grep `customTools` in tests; `tests/sandboxBuild.test.ts` shows the pattern)

**Interfaces:**

- Produces (`submitTool.ts`): `SUBMIT_TOOL_NAME = "junco_submit"`, `type SubmitRoute = "inbox" | "issue"`, `type Decision = "run" | "decline" | "aborted" | "expired"`, `interface SubmitProposal { commandId; draftId; ids; route }`, `interface SubmitToolDeps { findDraft(ref?): DraftLookup; confirm(p: SubmitProposal, signal?: AbortSignal): Promise<Decision>; run(draft: PendingDraft, route: SubmitRoute): Promise<SubmitRunResult>; record(rec: ChatWriteRecord): void; confirmTimeoutMinutes: number }`, `interface ChatToolDefinition { name; label; description; parameters: Record<string, unknown>; execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> }`, `makeSubmitTool(deps): ChatToolDefinition`.
- Produces (`submitExec.ts`): `interface SubmitRunResult { code: number | null; output: string; timedOut: boolean; archived: boolean; detail: string | null }`, `interface SubmitExecDeps extends CliRunnerDeps { store?: ReviewStoreDeps }`, `runSubmit(cfg, draft, route, deps?): Promise<SubmitRunResult>`.
- Produces (`chatSession.ts`): `ChatSessionDeps.submit?: SubmitExecDeps`; `decide(commandId, decision: "run" | "decline"): boolean`; `readonly pendingCommandId: string | null`.
- Produces (`chatManager.ts`): `decide(key, commandId, decision): Promise<ChatResult<{ settled: boolean }>>`.
- Produces (`session.ts`): `SessionOverrides.customTools?: unknown[]`.

- [ ] **Step 1: Failing tests for the pure tool**

`tests/submitTool.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  makeSubmitTool,
  SUBMIT_TOOL_NAME,
  type SubmitToolDeps,
  type Decision,
} from "../src/chat/submitTool.js";
import type { PendingDraft } from "../src/chat/draftStore.js";

const draft = (over: Partial<PendingDraft> = {}): PendingDraft => ({
  id: "acme__api-1",
  key: "acme/api",
  slug: "acme__api",
  kind: "ticket",
  files: [{ name: "add-readme.md", content: "", lint: [], route: null, droppedKeys: [] }],
  cwd: "/r",
  nwo: "acme/api",
  createdAt: "t",
  lintFailed: false,
  blocked: null,
  routeOverride: "auto",
  commandArgs: null,
  ...over,
});

function harness(o: {
  lookup?: ReturnType<SubmitToolDeps["findDraft"]>;
  decision?: Decision;
  run?: Awaited<ReturnType<SubmitToolDeps["run"]>>;
}) {
  const records: unknown[] = [];
  const calls: string[] = [];
  const deps: SubmitToolDeps = {
    findDraft: (ref) => (
      calls.push(`find:${ref ?? "-"}`),
      o.lookup ?? { ok: true, draft: draft() }
    ),
    confirm: async (p, signal) => {
      calls.push(`confirm:${p.commandId}:${p.route}`);
      if (signal?.aborted) return "aborted";
      return o.decision ?? "run";
    },
    run: async (d, route) => (
      calls.push(`run:${d.id}:${route}`),
      o.run ?? {
        code: 0,
        output: "queued add-readme\n",
        timedOut: false,
        archived: true,
        detail: null,
      }
    ),
    record: (r) => records.push(r),
    confirmTimeoutMinutes: 10,
  };
  return { tool: makeSubmitTool(deps), records, calls };
}

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("");

describe("junco_submit (pure)", () => {
  it("has the name the session allowlists and a plain JSON-schema parameter block", () => {
    const { tool } = harness({});
    expect(tool.name).toBe(SUBMIT_TOOL_NAME);
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: { draft: { type: "string" }, route: { enum: ["inbox", "issue"] } },
      additionalProperties: false,
    });
  });

  it("run: confirms, runs, records ran + the draft note, returns the outcome", async () => {
    const h = harness({});
    const r = await h.tool.execute("call_1", { draft: "add-readme" }, undefined);
    expect(h.calls).toEqual(["find:add-readme", "confirm:call_1:inbox", "run:acme__api-1:inbox"]);
    expect(text(r)).toMatch(/^submitted → inbox · add-readme \(exit 0\)/);
    expect(text(r)).toContain("queued add-readme");
    expect(h.records.map((x) => (x as { type: string; status?: string }).status)).toEqual([
      "submitted",
      "ran",
    ]);
    expect(h.records[0]).toMatchObject({ type: "junco_chat_draft", destination: "inbox" });
    expect(h.records[1]).toMatchObject({
      type: "junco_chat_command",
      commandId: "call_1",
      exitCode: 0,
      output: "queued add-readme\n",
    });
  });

  it("route:issue overrides the draft's route; a failed run records failed and keeps the draft", async () => {
    const h = harness({
      run: { code: 1, output: "boom", timedOut: false, archived: false, detail: null },
    });
    const r = await h.tool.execute("call_2", { route: "issue" }, undefined);
    expect(h.calls[2]).toBe("run:acme__api-1:issue");
    expect(text(r)).toMatch(/^submit failed \(exit 1\)/);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ status: "failed", exitCode: 1, route: "issue" });
  });

  it("decline / expired / aborted record their status and say the draft stays parked", async () => {
    for (const [decision, status] of [
      ["decline", "declined"],
      ["expired", "expired"],
      ["aborted", "aborted"],
    ] as const) {
      const h = harness({ decision });
      const r = await h.tool.execute("c", {}, undefined);
      expect(h.records[0]).toMatchObject({ type: "junco_chat_command", status });
      expect(h.calls.some((c) => c.startsWith("run:"))).toBe(false);
      expect(text(r)).toContain("stays parked");
    }
    const e = harness({ decision: "expired" });
    await e.tool.execute("c", {}, undefined);
    expect(e.records[0]).toMatchObject({ detail: "no decision in 10m" });
  });

  it("refuses before proposing: unknown, ambiguous, none, lint-failed, blocked", async () => {
    const d2 = draft({
      id: "acme__api-2",
      files: [{ name: "other.md", content: "", lint: [], route: null, droppedKeys: [] }],
    });
    await expect(
      harness({ lookup: { ok: false, reason: "unknown", candidates: [draft(), d2] } }).tool.execute(
        "c",
        { draft: "x" },
        undefined,
      ),
    ).rejects.toThrow(/no parked draft named "x".*add-readme.*other/s);
    await expect(
      harness({
        lookup: { ok: false, reason: "ambiguous", candidates: [draft(), d2] },
      }).tool.execute("c", {}, undefined),
    ).rejects.toThrow(/name one/);
    await expect(
      harness({ lookup: { ok: false, reason: "none", candidates: [] } }).tool.execute(
        "c",
        {},
        undefined,
      ),
    ).rejects.toThrow(/nothing is parked/);
    await expect(
      harness({ lookup: { ok: true, draft: draft({ lintFailed: true }) } }).tool.execute(
        "c",
        {},
        undefined,
      ),
    ).rejects.toThrow(/failed lint/);
    await expect(
      harness({ lookup: { ok: true, draft: draft({ blocked: "no_checkout" }) } }).tool.execute(
        "c",
        {},
        undefined,
      ),
    ).rejects.toThrow(/blocked/);
  });

  it("a pre-aborted signal never proposes", async () => {
    const h = harness({});
    const ctl = new AbortController();
    ctl.abort();
    const r = await h.tool.execute("c", {}, ctl.signal);
    expect(h.calls).toEqual(["find:-"]);
    expect(h.records).toEqual([]);
    expect(text(r)).toContain("aborted");
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run tests/submitTool.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Write the tool**

`src/chat/submitTool.ts`:

```ts
/**
 * `junco_submit` — the chat model's one action tool (spec 2026-09-03). It
 * submits an ALREADY-PARKED draft after the operator confirms in the
 * dashboard, blocking inside the model's turn so the model reports the real
 * outcome. SDK-free: the definition is a plain object with a plain
 * JSON-schema parameter block (the SDK's validator compiles JSON schema —
 * `pi-ai/dist/utils/validation.js`), cast at the single SDK boundary
 * (agent/session.ts) like the sandbox tools. Every side effect is a dep the
 * session binds (chatSession.ts): draft lookup, the confirmation wait, the
 * CLI run, the transcript record.
 */
import type { ChatWriteRecord } from "./chatSession.js";
import type { DraftLookup, PendingDraft } from "./draftStore.js";
import { draftTicketIds } from "./submitArgv.js";
import type { SubmitRunResult } from "./submitExec.js";

export const SUBMIT_TOOL_NAME = "junco_submit";
export type SubmitRoute = "inbox" | "issue";
export type Decision = "run" | "decline" | "aborted" | "expired";

export interface SubmitProposal {
  commandId: string;
  draftId: string;
  ids: string[];
  route: SubmitRoute;
}

export interface SubmitToolDeps {
  findDraft(ref: string | undefined): DraftLookup;
  /** Blocks until the operator decides, the turn aborts, or the confirm
   *  timeout elapses (chatSession.ts's confirmSubmit). */
  confirm(p: SubmitProposal, signal?: AbortSignal): Promise<Decision>;
  run(draft: PendingDraft, route: SubmitRoute): Promise<SubmitRunResult>;
  record(rec: ChatWriteRecord): void;
  confirmTimeoutMinutes: number;
}

/** The SDK's ToolDefinition, the parts junco fills — see
 * pi-coding-agent/dist/core/extensions/types.d.ts `ToolDefinition`. */
export interface ChatToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

const PARAMETERS = {
  type: "object",
  properties: {
    draft: {
      type: "string",
      description:
        "Which parked draft: its ticket id (the fence's `id:`) or its draft id. Omit when exactly one draft is parked.",
    },
    route: {
      type: "string",
      enum: ["inbox", "issue"],
      description:
        "Where it goes: `inbox` queues it for the worker now; `issue` parks it as an unlabeled GitHub issue for a human to label. Omit to keep the draft's own route.",
    },
  },
  additionalProperties: false,
} as const;

/** The route a submission takes when the model names none — the draft's
 * override, else the route decided at park time, else the inbox. */
export function effectiveRoute(d: PendingDraft, requested: SubmitRoute | undefined): SubmitRoute {
  if (requested !== undefined) return requested;
  if (d.routeOverride !== "auto") return d.routeOverride;
  return d.files[0]?.route?.destination === "issue" ? "issue" : "inbox";
}

const list = (ds: PendingDraft[]): string =>
  ds.map((d) => draftTicketIds(d).join(", ") || d.id).join("; ");

function resolveDraft(deps: SubmitToolDeps, ref: string | undefined): PendingDraft {
  const got = deps.findDraft(ref);
  if (!got.ok) {
    if (got.reason === "none")
      throw new Error("nothing is parked for this chat — draft a ticket first");
    if (got.reason === "unknown")
      throw new Error(`no parked draft named "${ref}" — parked: ${list(got.candidates)}`);
    throw new Error(`several drafts are parked — name one: ${list(got.candidates)}`);
  }
  const d = got.draft;
  if (d.lintFailed)
    throw new Error(
      `draft ${d.id} failed lint — the operator must edit it (e) or discard it first`,
    );
  if (d.blocked !== null)
    throw new Error(
      `draft ${d.id} is blocked (${d.blocked.replace(/_/g, " ")}) — it cannot be submitted`,
    );
  return d;
}

const OUTPUT_TAIL = 4096;
const tail = (s: string): string => (s.length <= OUTPUT_TAIL ? s : s.slice(s.length - OUTPUT_TAIL));

export function makeSubmitTool(deps: SubmitToolDeps): ChatToolDefinition {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: null });
  return {
    name: SUBMIT_TOOL_NAME,
    label: "junco submit",
    description:
      "Submit a draft this chat already parked (a `junco-ticket` fence from an earlier turn) — to the inbox, or as a parked GitHub issue. The call BLOCKS until the operator confirms or declines in the dashboard; report exactly what it returns. Only when the operator asks to submit/queue/dispatch/send; never in the turn that drafts.",
    parameters: PARAMETERS,
    async execute(toolCallId, params, signal) {
      const p = (params ?? {}) as { draft?: unknown; route?: unknown };
      const ref = typeof p.draft === "string" && p.draft !== "" ? p.draft : undefined;
      const requested = p.route === "inbox" || p.route === "issue" ? p.route : undefined;
      const draft = resolveDraft(deps, ref);
      if (signal?.aborted)
        return text("aborted before the operator was asked — the draft stays parked");
      const route = effectiveRoute(draft, requested);
      const ids = draftTicketIds(draft);
      const base = {
        type: "junco_chat_command" as const,
        commandId: toolCallId,
        command: "submit" as const,
        draftId: draft.id,
        ids,
        route,
      };
      const settled = (status: "declined" | "expired" | "aborted", detail: string | null): void =>
        deps.record({ ...base, status, exitCode: null, output: null, detail });
      const decision = await deps.confirm(
        { commandId: toolCallId, draftId: draft.id, ids, route },
        signal,
      );
      if (decision === "decline") {
        settled("declined", null);
        return text("the operator declined — the draft stays parked");
      }
      if (decision === "expired") {
        settled("expired", `no decision in ${deps.confirmTimeoutMinutes}m`);
        return text(
          `no decision within ${deps.confirmTimeoutMinutes} minutes — the draft stays parked`,
        );
      }
      if (decision === "aborted") {
        settled("aborted", null);
        return text("the turn was aborted — the draft stays parked");
      }
      const r = await deps.run(draft, route);
      const output = tail(r.output);
      if (r.code === 0 && r.archived) {
        deps.record({
          type: "junco_chat_draft",
          draftId: draft.id,
          kind: draft.kind,
          status: "submitted",
          ids,
          destination: route,
        });
        deps.record({ ...base, status: "ran", exitCode: 0, output, detail: null });
        return text(`submitted → ${route} · ${ids.join(", ")} (exit 0)\n${output}`.trimEnd());
      }
      const detail = r.detail ?? (r.timedOut ? "timed out" : null);
      deps.record({ ...base, status: "failed", exitCode: r.code, output, detail });
      return text(
        `submit failed (exit ${r.code ?? "?"})${detail ? ` — ${detail}` : ""} — the draft stays parked\n${output}`.trimEnd(),
      );
    },
  };
}
```

(The `junco_chat_command` proposed record is written by the session's `confirm` dep, not here — it is the session that knows the record is the card.)

- [ ] **Step 4: Run** — `npx vitest run tests/submitTool.test.ts` — Expected: PASS.

- [ ] **Step 5: Failing tests for the executor**

`tests/submitExec.test.ts` — a temp `chatDrafts` dir with one written draft (`writeChatDraft`, as `tests/draftStore.test.ts` does) and Task 3's `fakeSpawn` helper:

```ts
describe("runSubmit", () => {
  it("spawns `submit <file>` (or --as-issue), archives on exit 0, returns the merged output", async () => {
    const { spawnFn, calls } = fakeSpawn((c) => {
      c.stdout.emit("data", Buffer.from("queued\n"));
      c.emit("close", 0);
    });
    const r = await runSubmit(cfg, draft, "inbox", { spawnFn, cliPath: "/dist/cli.js" });
    expect(calls[0]).toEqual([
      "/dist/cli.js",
      "submit",
      draftFilePath(cfg, draft.id, "add-readme.md"),
    ]);
    expect(r).toMatchObject({ code: 0, archived: true, output: "queued\n" });
    expect(listChatDrafts(cfg)).toEqual([]); // archived under submitted/
    const asIssue = await runSubmit(cfg, draft2, "issue", { spawnFn, cliPath: "/dist/cli.js" });
    expect(calls[1]).toEqual([
      "/dist/cli.js",
      "submit",
      "--as-issue",
      draftFilePath(cfg, draft2.id, "x.md"),
    ]);
  });

  it("a non-zero exit stops the sequence, archives nothing, keeps the output", async () => {
    let n = 0;
    const { spawnFn, calls } = fakeSpawn((c) => {
      c.stdout.emit("data", Buffer.from(`run ${++n}\n`));
      c.emit("close", n === 1 ? 0 : 2);
    });
    const r = await runSubmit(cfg, twoFileSet, "inbox", { spawnFn, cliPath: "/dist/cli.js" });
    expect(calls).toHaveLength(2);
    expect(r).toMatchObject({
      code: 2,
      archived: false,
      detail: "1 of 2 files submitted before a failure",
    });
    expect(listChatDrafts(cfg).map((d) => d.id)).toContain(twoFileSet.id);
  });

  it("a draft that is no longer parked is refused without spawning", async () => {
    const { spawnFn, calls } = fakeSpawn(() => {});
    const r = await runSubmit(cfg, draft({ id: "gone" }), "inbox", {
      spawnFn,
      cliPath: "/dist/cli.js",
    });
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ code: null, archived: false, detail: "draft no longer parked" });
  });
});
```

- [ ] **Step 6: Write the executor**

`src/chat/submitExec.ts`:

```ts
/**
 * Runs the submit the operator just confirmed (spec 2026-09-03 §3.4): the
 * SAME argv the dashboard's `s` builds (submitArgv), the real CLI spawned
 * per file (cliSpawn.ts), first non-zero exit stops the sequence, archive on
 * success. The draft is re-read from disk first — the operator may have
 * pressed `s` in the meantime.
 */
import type { Config } from "../types.js";
import { spawnCli, type CliRunnerDeps } from "../cliSpawn.js";
import type { ReviewStoreDeps } from "../reviewStore.js";
import { archiveChatDraft, draftFilePath, readChatDraft, type PendingDraft } from "./draftStore.js";
import { submitArgv } from "./submitArgv.js";
import type { SubmitRoute } from "./submitTool.js";

export interface SubmitRunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  archived: boolean;
  detail: string | null;
}

export interface SubmitExecDeps extends CliRunnerDeps {
  store?: ReviewStoreDeps;
}

export async function runSubmit(
  cfg: Config,
  draft: PendingDraft,
  route: SubmitRoute,
  deps: SubmitExecDeps = {},
): Promise<SubmitRunResult> {
  const live = readChatDraft(cfg, draft.id, deps.store).entry;
  if (live === null)
    return {
      code: null,
      output: "",
      timedOut: false,
      archived: false,
      detail: "draft no longer parked",
    };
  const argvs = submitArgv({ ...live, routeOverride: route }, (name) =>
    draftFilePath(cfg, live.id, name),
  );
  if (argvs.length === 0)
    return {
      code: null,
      output: "",
      timedOut: false,
      archived: false,
      detail: "nothing to submit",
    };
  const chunks: string[] = [];
  for (const [i, argv] of argvs.entries()) {
    const r = await spawnCli(argv, deps);
    chunks.push(r.output);
    if (r.code !== 0) {
      // A ticket set submits one file per invocation; the earlier ones are
      // already queued and are not rolled back (chat spec §6.4).
      const detail = i > 0 ? `${i} of ${argvs.length} files submitted before a failure` : null;
      return {
        code: r.code,
        output: chunks.join(""),
        timedOut: r.timedOut,
        archived: false,
        detail,
      };
    }
  }
  const archived = archiveChatDraft(cfg, live.id, "submitted", deps.store);
  return {
    code: 0,
    output: chunks.join(""),
    timedOut: false,
    archived,
    detail: archived ? null : "submitted, but the draft did not archive",
  };
}
```

- [ ] **Step 7: Run** — `npx vitest run tests/submitExec.test.ts` — Expected: PASS.

- [ ] **Step 8: Failing session tests**

Append to `tests/chatSession.test.ts` (the file's `makeSession` and `fakeSm` are reusable; add a variant that captures overrides — see the Ruling R14 test at ~line 184):

```ts
describe("junco_submit wiring (spec 2026-09-03)", () => {
  it("passes the tool + its name to the factory when chat.submitTool is on, neither when off", async () => {
    for (const on of [true, false]) {
      const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
      let captured: SessionOverrides | undefined;
      const session = new ChatSession(
        {
          cfg: makeConfig({ ...cfgSeams, chat: { ...cfg.chat, submitTool: on } }),
          key: "acme/api",
          kind: "watched",
          cwd: root,
          nwo: "acme/api",
          dir: join(root, "acme__api"),
        },
        {
          makeSessionManager: fakeSm,
          sessionFactoryFor: (_c, _w, o) => (
            (captured = o),
            fakeChatSession([chatScriptText("hi")])
          ),
        },
      );
      await session.ensureSession();
      expect(captured!.tools?.includes("junco_submit")).toBe(on);
      expect((captured!.customTools ?? []).length).toBe(on ? 1 : 0);
      expect(captured!.appendSystemPrompt?.includes("junco_submit")).toBe(on);
    }
  });

  it("confirmSubmit: proposes, blocks, decide('run') resolves; the proposed record is on the bus", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    await session.ensureMeta();
    const seen: string[] = [];
    session.subscribe({
      onLine: (l) => seen.push(JSON.parse(l).status ?? JSON.parse(l).type),
      onEnd: () => {},
    });
    const p = session.confirmSubmit({ commandId: "c1", draftId: "d", ids: ["t"], route: "inbox" });
    expect(session.pendingCommandId).toBe("c1");
    expect(seen).toContain("proposed");
    expect(session.decide("nope", "run")).toBe(false);
    expect(session.decide("c1", "run")).toBe(true);
    expect(await p).toBe("run");
    expect(session.pendingCommandId).toBeNull();
  });

  it("confirmSubmit: a second proposal while one is pending is refused; decline and expiry settle", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    await session.ensureMeta();
    const p = session.confirmSubmit({ commandId: "c1", draftId: "d", ids: [], route: "inbox" });
    await expect(
      session.confirmSubmit({ commandId: "c2", draftId: "d", ids: [], route: "inbox" }),
    ).rejects.toThrow(/already awaiting/);
    session.decide("c1", "decline");
    expect(await p).toBe("decline");
    const fast = new ChatSession(
      {
        cfg: makeConfig({ ...cfgSeams, chat: { ...cfg.chat, confirmTimeoutMinutes: 1 } }),
        key: "acme/api",
        kind: "watched",
        cwd: root,
        nwo: "acme/api",
        dir: join(root, "x"),
      },
      {
        makeSessionManager: fakeSm,
        sessionFactoryFor: () => fakeChatSession([chatScriptText("hi")]),
        confirmTimeoutMs: 20,
      },
    );
    await fast.ensureMeta();
    expect(
      await fast.confirmSubmit({ commandId: "c3", draftId: "d", ids: [], route: "inbox" }),
    ).toBe("expired");
  });

  it("abort() settles a pending confirmation as aborted; so does the tool's own signal", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    await session.ensureMeta();
    const p = session.confirmSubmit({ commandId: "c1", draftId: "d", ids: [], route: "inbox" });
    await session.abort();
    expect(await p).toBe("aborted");
    const ctl = new AbortController();
    const q = session.confirmSubmit(
      { commandId: "c2", draftId: "d", ids: [], route: "inbox" },
      ctl.signal,
    );
    ctl.abort();
    expect(await q).toBe("aborted");
  });

  it("the turn deadline pauses while a confirmation is pending and resumes after", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    await session.ensureMeta();
    const deadline = session.deadlineForTest(1_000);
    const p = session.confirmSubmit({ commandId: "c1", draftId: "d", ids: [], route: "inbox" });
    expect(deadline.paused).toBe(true);
    session.decide("c1", "decline");
    await p;
    expect(deadline.paused).toBe(false);
  });

  it("startup closes a dangling proposed command as expired (daemon restarted)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const dir = join(root, "acme__api");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        key: "acme/api",
        kind: "watched",
        cwd: root,
        nwo: "acme/api",
        sdkSessionFile: join(dir, "s.jsonl"),
        createdAt: "t",
      }),
    );
    writeFileSync(
      join(dir, "transcript.jsonl"),
      [
        JSON.stringify({
          type: "junco_meta",
          version: 3,
          ticketId: "acme__api",
          createdAt: "t",
          ts: "t",
        }),
        JSON.stringify({
          type: "junco_chat_command",
          commandId: "c1",
          command: "submit",
          draftId: "d",
          ids: ["t"],
          route: "inbox",
          status: "proposed",
          exitCode: null,
          output: null,
          detail: null,
          ts: "t",
        }),
      ].join("\n") + "\n",
    );
    const { session } = makeSession(root);
    await session.ensureMeta();
    const lines = readFileSync(join(dir, "transcript.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({
      type: "junco_chat_command",
      commandId: "c1",
      status: "expired",
      detail: "daemon restarted",
    });
  });
});
```

(Refactor the file's top so the seams are reusable: `const cfgSeams = { dataDir: "/sbxroot/data", … } as const; const cfg = makeConfig(cfgSeams);` — the same ten values `tests/chatSession.test.ts:15-26` pass today. Use the schema's `TRANSCRIPT_VERSION` for `version` rather than hard-coding 3. `deadlineForTest` is a test-only accessor: it constructs and stores the session's `turnDeadline` the way `admit` does, so the pause can be observed without a real turn.)

- [ ] **Step 9: Wire the session**

`src/agent/session.ts` — `SessionOverrides`:

```ts
  /** Chat (spec 2026-09-03): bespoke tool definitions to register beside the
   *  built-ins — opaque here (plain objects shaped like the SDK's
   *  ToolDefinition), cast at the SDK boundary below like the sandbox tools.
   *  The SDK enables a custom tool only when `tools` lists its name. */
  customTools?: unknown[];
```

and in `makePiSessionFactory`, replace the `customTools` spread:

```ts
      ...(sandboxTools || overrides?.customTools
        ? { customTools: [...(sandboxTools ?? []), ...(overrides?.customTools ?? [])] as never }
        : {}),
```

`src/chat/chatSession.ts`:

1. Imports: `import { TurnDeadline, runChatTurn, type ChatTurnResult } from "./chatTurn.js";`, `import { makeSubmitTool, SUBMIT_TOOL_NAME, type Decision, type SubmitProposal } from "./submitTool.js";`, `import { runSubmit, type SubmitExecDeps } from "./submitExec.js";`, `import { findChatDraft } from "./draftStore.js";`, `type ChatCommandRecord` from the schema.
2. `ChatSessionDeps` gains `submit?: SubmitExecDeps;` and `/** Test seam for the confirm wait (default cfg.chat.confirmTimeoutMinutes × 60 000). */ confirmTimeoutMs?: number;`.
3. Fields:

```ts
  private toolNames: string[] | null = null;
  private turnDeadline: TurnDeadline | null = null;
  private pending: { commandId: string; settle: (d: Decision) => void } | null = null;
  private readonly submitDeps: SubmitExecDeps;
  private readonly confirmTimeoutMs: number;
```

set in the constructor: `this.submitDeps = deps.submit ?? {}; this.confirmTimeoutMs = deps.confirmTimeoutMs ?? opts.cfg.chat.confirmTimeoutMinutes * 60_000;`.

4. In `ensureSession`'s `build`:

```ts
        const submitTool = this.cfg.chat.submitTool ? makeSubmitTool(this.submitToolDeps()) : null;
        this.toolNames = submitTool ? [...chatCfg.tools, SUBMIT_TOOL_NAME] : chatCfg.tools;
        const built = await this.factoryFor(chatCfg, this.cwd, {
          tools: this.toolNames,
          ...(submitTool ? { customTools: [submitTool] } : {}),
          thinkingLevel: …(unchanged),
          sessionManager: manager,
          appendSystemPrompt: buildChatPrompt({ cwd: this.cwd, nwo: this.nwo, planSetsEnabled: this.cfg.planSets.enabled, submitTool: submitTool !== null }),
          readOnly: true,
        })();
```

(`buildChatPrompt`'s new `submitTool` option lands in Task 8; until then pass nothing and let Task 8 add it — or add the option now as a no-op boolean the prompt ignores. Do the latter: add `submitTool?: boolean` to the opts type in this task so the session compiles; Task 8 uses it.)

5. `admit`: the `turn_start` record's `tools: this.toolNames ?? chatCfg.tools`; before `runChatTurn`:

```ts
    const deadline = new TurnDeadline(opts.timeoutMs, this.now);
    this.turnDeadline = deadline;
    const run = runChatTurn(sdk, { …, deadline });
```

and in `settle`'s `finally`: `this.turnDeadline = null;`.

6. The handshake:

```ts
  get pendingCommandId(): string | null {
    return this.pending?.commandId ?? null;
  }

  /** The submit tool's `confirm` dep (spec 2026-09-03 §3.3): write the card's
   * record, stop the turn clock, and wait for the dashboard's decision — or
   * the turn's abort, or the confirm budget. Exactly one at a time. */
  async confirmSubmit(p: SubmitProposal, signal?: AbortSignal): Promise<Decision> {
    if (this.pending !== null)
      throw new Error("a submit is already awaiting the operator's confirmation");
    if (signal?.aborted) return "aborted";
    this.writeRecord({
      type: "junco_chat_command",
      commandId: p.commandId,
      command: "submit",
      draftId: p.draftId,
      ids: p.ids,
      route: p.route,
      status: "proposed",
      exitCode: null,
      output: null,
      detail: null,
    });
    this.turnDeadline?.pause();
    try {
      return await new Promise<Decision>((resolve) => {
        const timer = setTimeout(() => settle("expired"), this.confirmTimeoutMs);
        const onAbort = (): void => settle("aborted");
        const settle = (d: Decision): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (this.pending?.commandId === p.commandId) this.pending = null;
          resolve(d);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.pending = { commandId: p.commandId, settle };
      });
    } finally {
      this.turnDeadline?.resume();
    }
  }

  /** The dashboard's answer (POST /chat/decide). False when nothing with that
   * id is pending — a stale card, or a decision that raced the timeout. */
  decide(commandId: string, decision: "run" | "decline"): boolean {
    if (this.pending === null || this.pending.commandId !== commandId) return false;
    this.pending.settle(decision);
    return true;
  }

  private submitToolDeps(): SubmitToolDeps {
    return {
      findDraft: (ref) => findChatDraft(this.cfg, this.key, ref, this.submitDeps.store),
      confirm: (p, signal) => this.confirmSubmit(p, signal),
      run: (draft, route) => runSubmit(this.cfg, draft, route, this.submitDeps),
      record: (rec) => this.writeRecord(rec),
      confirmTimeoutMinutes: this.cfg.chat.confirmTimeoutMinutes,
    };
  }

  /** Tests only: a turn deadline without a turn, so the pause is observable. */
  deadlineForTest(ms: number): TurnDeadline {
    this.turnDeadline = new TurnDeadline(ms, this.now);
    this.turnDeadline.arm(() => {});
    return this.turnDeadline;
  }
```

7. `abort()`: first line after the early return: `this.pending?.settle("aborted");`.
8. `stampCrashIfNeeded`: track `const open = new Map<string, Omit<ChatCommandRecord, "ts">>();` — in the loop, `if (t === "junco_chat_command") { const c = p.record as ChatCommandRecord; if (c.status === "proposed") open.set(c.commandId, c); else open.delete(c.commandId); }`; after the crash stamp: `for (const c of open.values()) { const { ts: _ts, ...rest } = c; this.writeRecord({ ...rest, status: "expired", detail: "daemon restarted" }); }`. (Name it `stampDanglingIfNeeded` if you like; update the doc comment: "a turn record left at turn_start, or a command left at proposed, died with the daemon".)

`src/chat/chatManager.ts`:

```ts
  /** POST /chat/decide: the dashboard's y/n for a pending junco_submit. */
  async decide(
    key: string,
    commandId: string,
    decision: "run" | "decline",
  ): Promise<ChatResult<{ settled: boolean }>> {
    const got = await this.get(key);
    if (!got.ok) return got;
    return { ok: true, value: { settled: got.value.decide(commandId, decision) } };
  }
```

and pass `submit: this.deps.submit` through to `new ChatSession(…, { ...this.deps.session, submit: this.deps.submit, … })` with `ChatManagerDeps.submit?: SubmitExecDeps` (the daemon passes nothing; tests inject `spawnFn`).

- [ ] **Step 10: Manager test**

In `tests/chatManager.test.ts` (the file's `makeManager` harness):

```ts
it("decide() settles a pending confirmation and reports false for an unknown id", async () => {
  const { m } = makeManager();
  const got = await m.get("acme/api");
  if (!got.ok) throw new Error(got.error);
  await got.value.ensureMeta();
  const p = got.value.confirmSubmit({ commandId: "c1", draftId: "d", ids: [], route: "inbox" });
  expect(await m.decide("acme/api", "zzz", "run")).toEqual({ ok: true, value: { settled: false } });
  expect(await m.decide("acme/api", "c1", "run")).toEqual({ ok: true, value: { settled: true } });
  expect(await p).toBe("run");
});
```

- [ ] **Step 11: Run everything touched**

Run: `npx vitest run tests/submitTool.test.ts tests/submitExec.test.ts tests/chatSession.test.ts tests/chatManager.test.ts tests/chatTurn.test.ts tests/sandboxBuild.test.ts` and `npm run typecheck` — Expected: PASS.

- [ ] **Step 12: Commit**

```bash
npx prettier --write src/chat/submitTool.ts src/chat/submitExec.ts src/chat/chatSession.ts src/chat/chatManager.ts src/agent/session.ts tests/submitTool.test.ts tests/submitExec.test.ts tests/chatSession.test.ts tests/chatManager.test.ts tests/helpers/fakeSpawn.ts
git add -A && git commit -m "feat(chat): junco_submit tool — confirmation handshake, executor, session and SDK wiring"
```

---

### Task 6: `POST /chat/decide` and the dashboard client method

**Files:**

- Modify: `src/chat/chatRoutes.ts` (`ChatRoutesManager` pick; the POST allowlist ~line 251; a `case "/chat/decide"`)
- Modify: `src/tui/chatClient.ts` (`postChat`'s path union), `src/tui/chatClientMethods.ts` (`decide`), `src/tui/ghClient.ts` (`DashboardClient.chat.decide`), `tests/helpers/localFixtures.tsx` (`stubClient.chat.decide`)
- Test: `tests/chatRoutes.test.ts`, `tests/chatClientMethods.test.ts` (or wherever `note`'s client method is pinned — grep `postChat("note"`)

**Interfaces:**

- Produces: route `POST /chat/decide { key, commandId, decision }` → 202 settled / 409 `{ error: "not_pending" }` / 400 bad body.
- Produces: `client.chat.decide(key: string, commandId: string, decision: "run" | "decline"): Promise<Result<{ settled: boolean }>>`.

- [ ] **Step 1: Failing route tests**

In `tests/chatRoutes.test.ts`, extend `fakeManager` with `decide: async (...a) => (calls.push(["decide", ...a]), { ok: true, value: { settled: a[1] === "live" } })` (the fake settles only `commandId === "live"`), then:

```ts
it("POST /chat/decide: 202 when it settled a pending confirmation, 409 when nothing is pending, 400 on a bad body", async () => {
  const m = fakeManager();
  const url = await serve(m);
  const post = (body: unknown) =>
    fetch(`${url}/chat/decide`, { method: "POST", body: JSON.stringify(body) });
  expect((await post({ key: "k", commandId: "live", decision: "run" })).status).toBe(202);
  const stale = await post({ key: "k", commandId: "old", decision: "decline" });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: "not_pending" });
  expect((await post({ key: "k", commandId: "live", decision: "maybe" })).status).toBe(400);
  expect((await post({ key: "k", decision: "run" })).status).toBe(400);
  expect(m.calls.filter((c) => c[0] === "decide")).toEqual([
    ["decide", "k", "live", "run"],
    ["decide", "k", "old", "decline"],
  ]);
});
```

Also add `/chat/decide` to the file's existing "loopback / Origin / Host boundary applies to every /chat/\* path" case if it enumerates paths.

- [ ] **Step 2: Run** — `npx vitest run tests/chatRoutes.test.ts` — Expected: FAIL (404).

- [ ] **Step 3: The route**

`src/chat/chatRoutes.ts`: add `"decide"` to the `ChatRoutesManager` pick; add `path !== "/chat/decide"` to the POST allowlist condition; add the case:

```ts
      case "/chat/decide": {
        const { commandId, decision } = obj;
        if (
          typeof commandId !== "string" ||
          commandId === "" ||
          (decision !== "run" && decision !== "decline")
        )
          return json(res, 400, { error: "bad request" });
        const r = await manager.decide(key, commandId, decision);
        if (!r.ok) return fail(r.error);
        if (!r.value.settled) return json(res, 409, { error: "not_pending" });
        res.writeHead(202);
        res.end();
        return;
      }
```

- [ ] **Step 4: The client**

`src/tui/chatClient.ts`: `postChat`'s path type gains `"decide"`. `src/tui/ghClient.ts` `chat`:

```ts
    /** The y/n for a pending junco_submit card (spec 2026-09-03 §4.5).
     *  `settled: false` = the daemon had nothing pending under that id — a
     *  stale card; not an error. */
    decide(key: string, commandId: string, decision: "run" | "decline"): Promise<Result<{ settled: boolean }>>;
```

`src/tui/chatClientMethods.ts`:

```ts
      decide(key: string, commandId: string, decision: "run" | "decline") {
        return attempt(async () => {
          const r = await postChat("decide", { key, commandId, decision }, { fetchFn, baseUrl: healthBase });
          if (r.status === 409) return { settled: false };
          if (r.status !== 202) throw new Error(chatErr(r));
          return { settled: true };
        });
      },
```

`tests/helpers/localFixtures.tsx` `stubClient.chat`: `decide: async () => okv({ settled: true }),`. Client test beside `note`'s: 202 → `{settled:true}`, 409 → `{settled:false}`, 500 → `ok:false`.

- [ ] **Step 5: Run** — `npx vitest run tests/chatRoutes.test.ts tests/chatClient*.test.ts tests/tuiApp.chat.test.tsx`; `npm run typecheck` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/chat/chatRoutes.ts src/tui/chatClient.ts src/tui/chatClientMethods.ts src/tui/ghClient.ts tests/helpers/localFixtures.tsx tests/chatRoutes.test.ts
git add -A && git commit -m "feat(chat): POST /chat/decide and client.chat.decide"
```

---

### Task 7: The dashboard — pending state, the card's keys and footer, `/submit`

**Files:**

- Modify: `src/tui/hooks/useChat.ts` (`ChatState.pending`, `freshState`, `onRecord`, `toggleExpanded`, `decide`), `src/tui/hooks/useChatInput.ts` (`y`/`n`, `/submit`), `src/tui/viewActions.ts` (`StructuralOnlyView` + `structuralOnly("chatConfirm")`), `src/tui/footerModel.ts` (the `chatConfirm` actions row), `src/tui/hooks/useFooterBindings.ts` (`chatPending` input → `chatConfirm`), `src/tui/App.tsx` (pass `chatPending`; the two structural chip recipes `y`/`n` for the chat view), `src/tui/components/ChatView.tsx` (`chatHeaderStatus`), `src/tui/components/Composer.tsx` (`SLASH_COMMANDS`)
- Test: `tests/useChat.test.tsx`, `tests/useChatInput.test.tsx`, `tests/useFooterBindings.test.tsx`, `tests/footerModel.test.ts`, `tests/tuiChatView.test.tsx`, `tests/tuiApp.chat.test.tsx`, `tests/tuiViewActions.test.ts` (the `StructuralOnlyView` pin, if any)

**Interfaces:**

- Consumes: `commandAnchor` (Task 1), `client.chat.decide` (Task 6), `findChatDraft`'s rules (Task 3 — re-implemented on the loaded `chat.drafts` list for `/submit`, since the dashboard has the list in memory).
- Produces: `ChatState.pending: { commandId: string; draftId: string; ids: string[]; route: "inbox" | "issue" } | null`; `ChatApi.decide(decision: "run" | "decline"): Promise<void>`; `StructuralOnlyView` `"chatConfirm"`; `FooterBindingsInput.chatPending: boolean`.

- [ ] **Step 1: Failing hook tests**

`tests/useChat.test.tsx` — in the walk test (or a new `it`), after the session is live and has a summary:

```ts
// A proposed junco_submit blurs the composer and parks the cursor on the
// card; its terminal record clears `pending` and reloads the drafts.
api.focusComposer(true);
c.push(70, commandLine({ status: "proposed" }));
await until(() => api.chat!.pending?.commandId === "call_1");
expect(api.chat!.composerFocused).toBe(false);
expect(anchorIds(api.chat!.summary!)[api.chat!.cursor]).toBe(commandAnchor("call_1"));
expect(api.chat!.reveal).toBe(true);
c.push(80, commandLine({ status: "ran", exitCode: 0, output: "ok" }));
await until(() => api.chat!.pending === null);
await until(() => listCalls >= 2); // reloadDrafts ran again (count the fake's listChatDrafts calls)
// ⏎ on the card toggles its output.
api.toggleExpanded();
await until(() => api.chat!.expanded.has(commandAnchor("call_1")));
```

with a `commandLine(over)` helper mirroring Task 1's record (`commandId: "call_1"`), and a `decide` case:

```ts
  it("decide() posts the pending command's id; a stale decision surfaces as an error", async () => {
    const decisions: string[] = [];
    const c = makeClient({ decide: async (_k, id, d) => (decisions.push(`${id}:${d}`), okv({ settled: decisions.length === 1 })) });
    …open, push proposed…
    await api.decide("run");
    expect(decisions).toEqual(["call_1:run"]);
    await api.decide("decline"); // still pending in state — the fake says not settled
    await until(() => api.chat!.error === "that confirmation is no longer pending");
  });
```

`tests/useChatInput.test.tsx`:

```ts
it("blurred with a pending submit: y runs, n declines; the draft verbs are off the keymap", () => {
  const pending = { commandId: "c1", draftId: "d", ids: ["t"], route: "inbox" as const };
  const h = mount({ chat: chatState({ pending }) });
  h.api.handleChatKey("y", K());
  h.api.handleChatKey("n", K());
  expect(h.calls).toEqual(["decide:run", "decide:decline"]);
});

it("/submit submits the only parked draft through the card's path; names one by ticket id; refuses while pending", () => {
  const d1 = draftFixture("acme__api-1", "add-readme.md");
  const d2 = draftFixture("acme__api-2", "other.md");
  const one = mount({ chat: chatState({ drafts: [d1] }) });
  one.api.onComposerSubmit("/submit");
  expect(one.calls).toEqual(["submit:acme__api-1"]);
  const two = mount({ chat: chatState({ drafts: [d1, d2] }) });
  two.api.onComposerSubmit("/submit");
  expect(two.calls[0]).toMatch(/^toast:error:several drafts are parked/);
  two.api.onComposerSubmit("/submit other");
  expect(two.calls[1]).toBe("submit:acme__api-2");
  const busy = mount({
    chat: chatState({
      drafts: [d1],
      pending: { commandId: "c", draftId: "acme__api-1", ids: ["add-readme"], route: "inbox" },
    }),
  });
  busy.api.onComposerSubmit("/submit");
  expect(busy.calls[0]).toMatch(/^toast:info:a submit is already awaiting/);
});
```

(`mount`'s fake `chatApi` gains `decide: async (d) => void calls.push(`decide:${d}`)`; `chatDraftActions.submit` already records `submit:<id>`.)

`tests/useFooterBindings.test.tsx` / `tests/footerModel.test.ts`: with `view: "chat", composerFocused: false, chatPending: true` the context is `{ kind: "structuralOnly", view: "chatConfirm" }`; `buildFooterRows` for it yields actions `[pill y submit, n keep parked]` and navigate `[↑↓ scroll, ⇞ ⇟ page, i compose, esc back]` with an EMPTY keymap. `tests/tuiChatView.test.tsx`: `chatHeaderStatus(base({ pending }))` → `{ text: "◐ awaiting your confirmation", tone: "accent" }`, taking precedence over `streaming`.

- [ ] **Step 2: Run** — the five files — Expected: FAIL.

- [ ] **Step 3: State and reducer (`useChat.ts`)**

`ChatState`: `/** A junco_submit awaiting the operator's y/n (spec 2026-09-03 §4.1). */ pending: { commandId: string; draftId: string; ids: string[]; route: "inbox" | "issue" } | null;` — `freshState`: `pending: null`. In `onRecord`, after `draftsChanged`:

```ts
const command = rec?.type === "junco_chat_command" ? rec : null;
const settledCommand = command !== null && command.status !== "proposed";
```

inside the updater, after the existing record branches:

```ts
if (command?.status === "proposed") {
  const at = anchorIds(summary).indexOf(commandAnchor(command.commandId));
  next = {
    ...next,
    pending: {
      commandId: command.commandId,
      draftId: command.draftId,
      ids: command.ids,
      route: command.route,
    },
    composerFocused: false,
    ...(at >= 0 ? { cursor: at, follow: false, reveal: true } : {}),
  };
} else if (settledCommand && next.pending?.commandId === command.commandId) {
  next = { ...next, pending: null };
}
```

and after `setChat`: `if (draftsChanged || settledCommand) void reloadDrafts();`. `toggleExpanded`: keep the `draft:` early return (a draft card has no body) — `cmd:` anchors fall through to the toggle. `decide`:

```ts
const decide = useCallback(
  async (decision: "run" | "decline"): Promise<void> => {
    const key = keyRef.current;
    const pending = pendingRef.current;
    if (key === null || pending === null) return;
    const r = await client.chat.decide(key, pending.commandId, decision);
    if (!aliveRef.current) return;
    const error = !r.ok
      ? r.error
      : r.value.settled
        ? null
        : "that confirmation is no longer pending";
    if (error !== null) setChat((s) => (s === null ? s : { ...s, error }));
  },
  [client, aliveRef],
);
```

with `pendingRef` synced from state the way `composerRef` is (`pendingRef.current = chat?.pending ?? null` in the render body, like `composerRef`). Add `decide` to `ChatApi` and the return.

- [ ] **Step 4: Keys and `/submit` (`useChatInput.ts`)**

Blurred branch, before the `i` line:

```ts
// A junco_submit card awaits the operator (spec 2026-09-03 §4.3): y/n
// answer it; the draft verbs are unbound meanwhile (chatConfirm's empty
// keymap), so the same draft cannot also be submitted by `s`.
if (chat.pending !== null) {
  if (input === "y") return took(() => void decide("run"));
  if (input === "n") return took(() => void decide("decline"));
}
```

(`decide` from `chatApi`.) In `onComposerSubmit`'s switch, a `case "submit"`:

```ts
        case "submit": {
          if (chat?.pending) return void showToast("info", "a submit is already awaiting your confirmation (y/n)");
          const mine = chat?.drafts ?? [];
          const ref = arg?.trim() || undefined;
          const hit =
            ref === undefined
              ? mine
              : mine.filter((d) => d.id === ref || d.files.some((f) => f.name === ref || f.name === `${ref}.md`));
          const names = (ds: PendingDraft[]) => ds.map((d) => d.files.map((f) => f.name.replace(/\.md$/, "")).join(", ") || d.id).join("; ");
          if (mine.length === 0) return void showToast("error", "nothing is parked — /draft first");
          if (hit.length === 0) return void showToast("error", `no parked draft named "${ref}" — parked: ${names(mine)}`);
          if (hit.length > 1) return void showToast("error", `several drafts are parked — name one: ${names(hit)}`);
          return void chatDraftActions.submit(hit[0]!);
        }
```

(`onComposerSubmit`'s deps gain `chat?.pending`, `chat?.drafts`, `chatDraftActions` — it is a `useCallback`; list them.) `Composer.tsx` `SLASH_COMMANDS`: `{ name: "submit", hint: "submit [id] — submit the parked draft (the only one, or the named one)", takesArg: true },` after `draft`.

- [ ] **Step 5: Footer context and rows**

`viewActions.ts`: `StructuralOnlyView` gains `| "chatConfirm"`; `structuralOnly`:

```ts
    case "chatConfirm":
      // A junco_submit card is waiting (spec 2026-09-03 §4.3): the answer keys
      // live on the ACTIONS row (footerModel.ts); this navigate row lists what
      // still works meanwhile. Empty keymap on purpose — no draft verb may
      // fire while the daemon holds a submit of that same draft.
      return [s("↑/↓", "scroll"), s("pgup/pgdn", "page"), s("i", "compose"), s("esc", "back")];
```

`footerModel.ts`, beside the `chatCompose` chips:

```ts
const chatConfirm =
  context.view === "chatConfirm"
    ? [
        {
          kind: "pill" as const,
          id: "y",
          key: "y",
          label: "submit",
          charIndex: null,
          guarded: false,
        },
        s("n", "keep parked"),
      ]
    : [];
```

and `chips: context.view === "chatConfirm" ? chatConfirm : chatCompose`. `useFooterBindings.ts`: `FooterBindingsInput.chatPending: boolean`; the chat branch:

```ts
if (view === "chat")
  return composerFocused
    ? { kind: "structuralOnly", view: "chatCompose" }
    : chatPending
      ? { kind: "structuralOnly", view: "chatConfirm" }
      : { kind: "view", view: "chat" };
```

(add `chatPending` to the memo deps). `App.tsx`: `chatPending: chatState?.pending !== null && chatState?.pending !== undefined` → write it as `chatPending: (chatState?.pending ?? null) !== null,` in the `useFooterBindings` call (+1 line), and in `structuralChipActions`' `case "chat"` return `{ y: () => void chatApi.decide("run"), n: () => void chatApi.decide("decline") }` (+1 line, the comment updated: the esc state machine stays keyboard-only; the confirm chips are the one exception because a mouse user has no other way to answer). Ratchet: 1880 → 1882, itemised in `eslint.config.js`.

`ChatView.tsx` `chatHeaderStatus`, before the `streaming` line: `if (s.pending) return { text: "◐ awaiting your confirmation", tone: "accent" };`. `HelpModal.tsx`: verify `structuralOnly` views render their chips generically (grep `chatCompose` there — if it enumerates, add `chatConfirm`).

- [ ] **Step 6: App-level round trip**

`tests/tuiApp.chat.test.tsx`:

```ts
it("a proposed junco_submit shows the card, blurs the composer, y decides, the terminal record clears it", async () => {
  const decisions: string[] = [];
  const c = chatClient();
  c.client.chat.decide = async (_k, id, d) => (
    decisions.push(`${id}:${d}`),
    { ok: true, value: { settled: true } }
  );
  const r = renderApp({ client: c.client });
  await until(() => r.lastFrame()!.includes(LOADED));
  r.stdin.write("c");
  await until(() => r.lastFrame()!.includes("chat · acme/api"));
  c.push(10, metaLine({ ticketId: "acme__api" }));
  c.push(20, chatPrompt({ text: "submit it" }));
  c.push(30, chatTurnStart());
  c.push(40, commandLine({ status: "proposed" }));
  await until(() => r.lastFrame()!.includes("awaiting you · y submit · n keep parked"));
  expect(r.lastFrame()).toContain("◐ awaiting your confirmation");
  expect(r.lastFrame()).toContain("keep parked"); // footer actions row
  expect(r.lastFrame()).not.toContain("esc blur/abort"); // composer blurred
  r.stdin.write("y");
  await until(() => decisions.length === 1);
  expect(decisions).toEqual(["call_1:run"]);
  c.push(50, commandLine({ status: "ran", exitCode: 0, output: "queued add-readme" }));
  c.push(60, chatTurnEnd());
  await until(() => r.lastFrame()!.includes("✓ submitted → inbox · add-readme · exit 0"));
  expect(r.lastFrame()).not.toContain("keep parked");
  r.stdin.write("\r"); // ⏎ on the card expands the CLI output
  await until(() => r.lastFrame()!.includes("queued add-readme"));
});
```

- [ ] **Step 7: Run** — `npx vitest run tests/useChat.test.tsx tests/useChatInput.test.tsx tests/useFooterBindings.test.tsx tests/footerModel.test.ts tests/tuiChatView.test.tsx tests/tuiApp.chat.test.tsx tests/tuiViewActions.test.ts tests/tuiHelpModal*.test.tsx`; `npx eslint src/tui`; `npm run typecheck` — Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npx prettier --write src/tui tests/useChat.test.tsx tests/useChatInput.test.tsx tests/useFooterBindings.test.tsx tests/footerModel.test.ts tests/tuiChatView.test.tsx tests/tuiApp.chat.test.tsx eslint.config.js
git add -A && git commit -m "feat(tui): the junco_submit card — y/n, footer context, header, /submit"
```

---

### Task 8: The prompt, the docs, the hard rule, the changelog

**Files:**

- Modify: `src/chat/chatPrompt.ts` (`buildChatPrompt` opts + framing), `docs/dashboard.md` (chat section), `docs/configuration.md` (already has the rows from Task 2 — add one sentence to the Chat intro), `CLAUDE.md` (the `/chat/*` hard-rule bullet), `CHANGELOG.md` (`[Unreleased]` › Added), `README.md` (the chat paragraph, if it lists what the chat can do — grep `chat`)
- Test: `tests/chatPrompt.test.ts`, `tests/docsChangelog.test.ts` (existing)

- [ ] **Step 1: Failing prompt test**

`tests/chatPrompt.test.ts`:

```ts
it("teaches junco_submit only when the tool is registered, and keeps the read-only framing otherwise", () => {
  const on = buildChatPrompt({
    cwd: "/repo",
    nwo: "acme/api",
    planSetsEnabled: false,
    submitTool: true,
  });
  expect(on).toMatch(/junco_submit[\s\S]*only when the operator asks/i);
  expect(on).toMatch(/never in the same turn/i);
  expect(on).toMatch(/blocks until/i);
  const off = buildChatPrompt({
    cwd: "/repo",
    nwo: "acme/api",
    planSetsEnabled: false,
    submitTool: false,
  });
  expect(off).not.toContain("junco_submit");
  expect(off).toMatch(/You never run, submit, or dispatch anything/);
});
```

- [ ] **Step 2: The prompt**

`buildChatPrompt`'s opts gain `submitTool?: boolean` (Task 5 already threads it). Replace the framing's last two sentences with a branch:

```ts
const submitClause = opts.submitTool
  ? `You have exactly one action tool, \`junco_submit\`: it submits a draft this chat has
ALREADY parked — to the inbox, or as a parked GitHub issue — after the operator confirms in
the dashboard. The call blocks until they decide; use it only when the operator asks to
submit, queue, dispatch, or send a draft, and never in the same turn you draft it (a draft
is parked when your turn ends, so it does not exist yet). Name the draft by its ticket id.
Report exactly what the tool returned; never claim a submission the tool did not return
"submitted" for. Everything else stays read-only: you never run a shell, and every other
action is the operator's, on the dashboard.`
  : `You never run, submit, or dispatch anything; junco parks every draft for the operator
to review and submit. Never claim that a ticket was submitted, that a PR exists, or that
work has started.`;
```

and the framing template reads `… DRAFT it as a junco ticket. ${submitClause}` — keep the #475 draft-card paragraph after it, amending its last sentence: "When the operator asks you to submit … point them at that card" becomes "— or, when \`junco_submit\` is available, call it" only in the `on` branch (fold that phrase into `submitClause` rather than branching twice).

- [ ] **Step 3: Docs**

`docs/dashboard.md` — in the chat section (after the `/issue N` paragraph), add:

```
Asking the chat to **submit** a draft it parked ("submit it", "queue the README ticket")
makes the agent call its one action tool, `junco_submit`. Nothing runs yet: a card
appears under the answer — `▸ submit add-readme → inbox — awaiting you · y submit · n keep parked`
— the composer blurs, the header reads `◐ awaiting your confirmation`, and the agent's turn
waits (its own clock paused) until you press `y` or `n`. `y` runs the same `junco submit`
the card's `s` would, the card becomes `✓ submitted → inbox …` (`⏎` shows the CLI output),
and the agent reports the outcome in the same reply; `n` keeps the draft parked and tells
it so. No decision for `chat.confirmTimeoutMinutes` (10) expires the proposal. While a
proposal waits, the draft verbs are off — the same draft cannot be submitted twice — and
`i` still opens the composer (a message typed now reaches the agent after it decides).
`/submit [id]` in the composer submits the parked draft directly, no agent turn spent.
The agent can do nothing else: no other CLI verb, no shell, and it never moves your view.
```

Also add `y`/`n` to the per-context keys table row for the chat view: `chat view (submit awaiting you) | y submit · n keep parked`.

`docs/configuration.md` § Chat intro: append "With `chat.submitTool` on (the default) the agent can submit a draft it parked — after you confirm in the dashboard; see [Dashboard](dashboard.md)."

`CLAUDE.md` — the `/chat/*` hard-rule bullet's second sentence becomes: "The chat session's tools are the Q&A read-only subset plus exactly one action tool, `junco_submit` (spec `docs/superpowers/specs/2026-09-03-chat-submit-tool-design.md`), which submits an already-parked draft only after the operator answers `y` on the dashboard card — never widen beyond that; drafts pass a frontmatter allowlist (`fenceExtract.ts`) — never let model output set `repo:`/`tools:`/`network:`/`workdir:`."

`CHANGELOG.md` `[Unreleased]` › Added:

```
- The dashboard chat can now submit the work it drafts. Asking the agent to submit/queue a parked draft makes it call its one action tool, `junco_submit`, which proposes the submission as a card in the chat — `y` runs the same `junco submit` the card's `s` does (inbox, or `--as-issue`), `n` keeps the draft parked — and the agent's turn waits for the answer (its own timeout paused) so it reports the real outcome in the same reply. `/submit [id]` in the composer submits a parked draft directly. New levers `chat.submitTool` (default on) and `chat.confirmTimeoutMinutes` (default 10); new transcript record `junco_chat_command`; new loopback route `POST /chat/decide`. The agent's file tools stay read-only and it still cannot run a shell; nothing else on the dashboard is reachable from the chat.
```

- [ ] **Step 4: Run** — `npx vitest run tests/chatPrompt.test.ts tests/docsChangelog.test.ts tests/docs*.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/chat/chatPrompt.ts tests/chatPrompt.test.ts docs/dashboard.md docs/configuration.md CLAUDE.md CHANGELOG.md README.md
git add -A && git commit -m "docs(chat): teach the model junco_submit; document the card, the levers, the widened hard rule"
```

---

### Task 9: End-to-end — the SDK registers, runs, and settles the custom tool

**Files:**

- Create: `tests/e2e/chatSubmit.e2e.ts`
- Modify (only if needed): `tests/e2e/harness.ts` (a `chatEvents(sb, key)` helper that reads the transcript file under `sb.dataDir` — simpler than consuming SSE in the test)

**Interfaces:**

- Consumes: the harness's `createSandbox({ script, config })`, `spawnDaemon`/`spawnCli(sb, ["start"])`, `waitFor`, `queueState`, the stub's `{ kind: "tool", calls: [...] }` turn shape (`tests/e2e/stubModel.ts:21-29`), and `POST /chat/prompt` / `POST /chat/decide` on `http://127.0.0.1:${sb.healthPort}`.

- [ ] **Step 1: Write the scenario**

````ts
/**
 * The junco_submit round trip against the REAL SDK (spec 2026-09-03 §9): the
 * only test that proves the custom tool is registered, blocks the turn, is
 * settled by /chat/decide, and lands the draft in the inbox. The stub model
 * scripts two turns: one that drafts a ticket fence, one that calls the tool
 * and then acknowledges its result.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createSandbox, spawnCli, waitFor, type Sandbox, type DaemonHandle } from "./harness.js";

const FENCE = [
  "```junco-ticket",
  "---",
  "id: e2e-chat-submit",
  "priority: normal",
  "timeout_minutes: 5",
  "---",
  "# Add a note",
  "",
  "## Why",
  "",
  "Prove the chat can queue work.",
  "",
  "## Steps",
  "",
  "- [ ] Create `NOTE.md` containing `hello`.",
  "",
  "## Verification (junco runs this — do NOT run it yourself)",
  "",
  "```bash",
  "test -f NOTE.md",
  "```",
  "```",
].join("\n");

describe("e2e: chat junco_submit", () => {
  let sb: Sandbox | undefined;
  let daemon: DaemonHandle | undefined;
  afterEach(async () => {
    daemon?.child.kill("SIGTERM");
    await daemon?.exited;
    await sb?.dispose();
  });

  it("drafts, proposes, is confirmed over /chat/decide, and queues the ticket", async () => {
    sb = await createSandbox({
      script: [
        { kind: "text", text: `Here is the ticket.\n\n${FENCE}` },
        { kind: "tool", calls: [{ name: "junco_submit", args: { draft: "e2e-chat-submit" } }] },
        { kind: "text", text: "Submitted." },
      ],
      // The worker must NOT pick the ticket up during the test: a huge poll
      // interval keeps the inbox file where the assertion can see it.
      config: { worker: { pollIntervalSeconds: 3600 }, chat: { confirmTimeoutMinutes: 5 } },
    });
    daemon = spawnCli(sb, ["start"]);
    const base = `http://127.0.0.1:${sb.healthPort}`;
    await waitFor(
      async () => {
        try {
          return (await fetch(`${base}/health`)).ok;
        } catch {
          return false;
        }
      },
      { timeoutMs: 20_000, label: "/health" },
    );
    const key = sb.git.work; // a local checkout is a chat key (chatCwd.ts)
    const post = (path: string, body: unknown) =>
      fetch(`${base}/chat/${path}`, { method: "POST", body: JSON.stringify(body) });

    // Turn 1: the draft is parked when the turn ends.
    expect((await post("prompt", { key, text: "draft a ticket" })).status).toBe(202);
    const draftsDir = join(sb.dataDir, "data", "chat-drafts");
    await waitFor(() => readdirSync(draftsDir).some((f) => f.endsWith(".json")), {
      timeoutMs: 30_000,
      label: "draft parked",
    });

    // Turn 2: the tool call blocks on the proposal.
    expect((await post("prompt", { key, text: "submit it" })).status).toBe(202);
    const transcriptPath = () => {
      const chats = join(sb!.dataDir, "data", "chats");
      const dir = readdirSync(chats).find((d) => !d.startsWith("_"))!;
      return join(chats, dir, "transcript.jsonl");
    };
    const records = () =>
      readFileSync(transcriptPath(), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    const proposed = () =>
      records().find((r) => r.type === "junco_chat_command" && r.status === "proposed");
    await waitFor(() => proposed() !== undefined, {
      timeoutMs: 30_000,
      label: "junco_chat_command proposed",
    });
    const commandId = proposed()!.commandId as string;

    // A stale id is refused; the live one settles the turn.
    expect((await post("decide", { key, commandId: "nope", decision: "run" })).status).toBe(409);
    expect((await post("decide", { key, commandId, decision: "run" })).status).toBe(202);
    await waitFor(
      () => records().some((r) => r.type === "junco_chat_command" && r.status === "ran"),
      { timeoutMs: 60_000, label: "junco_chat_command ran" },
    );
    await waitFor(() => records().some((r) => r.type === "junco_chat_turn_end"), {
      timeoutMs: 30_000,
      label: "turn ended",
    });

    const inbox = readdirSync(join(sb.queueRoot, "inbox"));
    expect(inbox.some((f) => f.includes("e2e-chat-submit"))).toBe(true);
    expect(readdirSync(draftsDir).some((f) => f.endsWith(".json"))).toBe(false); // archived
    expect(records().some((r) => r.type === "junco_chat_draft" && r.status === "submitted")).toBe(
      true,
    );
  });
});
````

(Adjust the data-tree paths to what `dataTreePaths(cfg)` yields under the sandbox — `sb.dataDir` may already be the `data/` root; read `tests/e2e/harness.ts`'s `createSandbox` to pick the right join. `spawnCli(sb, ["start"])` is the harness's daemon spawn — `daemon.e2e.ts` uses `spawnDaemon`; use whichever exists. If the chat's SDK session needs `model.baseUrl` set, `createSandbox` with `script` already points `model` at the stub.)

- [ ] **Step 2: Build and run it**

Run: `npm run build && npx vitest run --config vitest.e2e.config.ts tests/e2e/chatSubmit.e2e.ts` (or however `npm run test:e2e` selects files — read `package.json`). Expected: PASS. If the stub reports `exhausted`, the SDK asked for more turns than scripted — add the missing `text` turn.

- [ ] **Step 3: Commit**

```bash
npx prettier --write tests/e2e/chatSubmit.e2e.ts tests/e2e/harness.ts
git add -A && git commit -m "test(e2e): junco_submit round trip through the real SDK and /chat/decide"
```

---

## Final gate

`npm run lint && npm run format:check && npm run typecheck && npm run build && npm test && npm run test:e2e`, then `npx vitest run --coverage` (floors 92/85/90/94 + the per-tree floors in `vitest.config.ts`). Verify live from the worktree's `dist` in tmux (the QA recipe: `node <worktree>/dist/cli.js dashboard`, `c`, type "submit it", watch the card, press `y`) — only with the maintainer's go-ahead, since it spends a model turn.
