/**
 * tests/e2e/chatSubmit.e2e.ts — the `junco_submit` round trip against the REAL
 * Pi SDK (spec 2026-09-03 §9's last bullet).
 *
 * Every other test of the tool fakes the SDK. This is the only one that proves
 * the SDK actually: registers the plain-object tool definition, ENABLES it
 * because the `tools` allowlist names it (§3.2), passes the model's arguments
 * into `execute`, holds the turn open while `execute` awaits the operator's
 * decision (§3.3), and feeds the tool's result back into the next request.
 *
 * The scripted turns are: (1) an answer carrying a `junco-ticket` fence, which
 * the turn hook parks as a draft; (2) a `junco_submit` call naming that draft;
 * (3) the model's acknowledgement of the tool result. A fourth request means
 * the SDK asked for a turn nobody scripted — the fail-fast stub reports that as
 * `exhausted`, which is asserted rather than papered over.
 *
 * The fence uses FOUR backticks on purpose: its `## Verification` block is a
 * three-backtick `bash` fence, and a three-backtick outer fence would be closed
 * by that inner opener (fenceExtract.ts's OPEN_PATCH_FENCE_RE comment — real
 * CommonMark ambiguity). It is lint-clean, so parking never triggers the
 * automatic lint-retry turn, which would consume a scripted turn of its own.
 */
import { existsSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import {
  chatDraftArchivePath,
  chatDrafts,
  chatRequests,
  chatTranscript,
  createSandbox,
  ghLog,
  queueState,
  spawnDaemon,
  stub,
  waitFor,
  type DaemonHandle,
  type Sandbox,
} from "./harness.js";
import type { ChatCommandRecord, JuncoRecord } from "../../src/agent/transcriptSchema.js";

const TICKET_ID = "e2e-chat-submit";

const FENCE = [
  "````junco-ticket",
  "---",
  `id: ${TICKET_ID}`,
  "priority: normal",
  "timeout_minutes: 5",
  "---",
  "# Add a note",
  "",
  "## Why",
  "",
  "Prove the dashboard chat can queue work through `junco_submit`.",
  "",
  "## Files",
  "",
  "| File      | Action | Lines | Notes        |",
  "| --------- | ------ | ----- | ------------ |",
  "| `NOTE.md` | new    | 1     | the greeting |",
  "",
  "## Steps",
  "",
  "### Step 1 — Add NOTE.md",
  "",
  "- [ ] Create `NOTE.md` containing `hello`.",
  '- [ ] Commit: `git add NOTE.md && git commit -m "docs: add NOTE.md"`',
  "",
  "## Verification (junco runs this — do NOT run it yourself)",
  "",
  "```bash",
  "test -f NOTE.md",
  "```",
  "",
  "## Done when",
  "",
  "- [ ] `NOTE.md` exists at the repo root.",
  "````",
].join("\n");

describe("e2e: chat junco_submit", () => {
  let sb: Sandbox | null = null;
  let daemon: DaemonHandle | null = null;
  afterEach(async () => {
    if (daemon && daemon.child.exitCode === null) daemon.child.kill("SIGKILL");
    daemon = null;
    await sb?.close();
    sb = null;
  });

  it("chat-submit: the SDK runs junco_submit, /chat/decide settles it, and the ticket lands in the inbox", async () => {
    const sandbox = await createSandbox({
      script: [
        { kind: "text", text: `Here is the ticket.\n\n${FENCE}\n` },
        { kind: "tool", calls: [{ name: "junco_submit", args: { draft: TICKET_ID } }] },
        { kind: "text", text: "Submitted." },
      ],
      config: {
        // The worker must NOT claim the ticket during the test: the inbox
        // assertion needs the file still queued. The startup poll is the one
        // this daemon runs (before anything is submitted); the next one is an
        // hour away.
        worker: { pollIntervalSeconds: 3600 },
        chat: { confirmTimeoutMinutes: 5 },
      },
    });
    sb = sandbox;
    const base = `http://127.0.0.1:${sandbox.healthPort}`;
    daemon = spawnDaemon(sandbox);
    await waitFor(
      async () => {
        try {
          return (await fetch(`${base}/health`)).ok;
        } catch {
          return false;
        }
      },
      { timeoutMs: 20_000, label: "/health responds" },
    );

    // A local checkout path IS a chat key (chatCwd.ts's local branch).
    const key = sandbox.git.work;
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${base}/chat/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const records = (): JuncoRecord[] =>
      chatTranscript(sandbox, key).flatMap((l) => (l.kind === "junco" ? [l.record] : []));
    const commands = (): ChatCommandRecord[] =>
      records().filter((r): r is ChatCommandRecord => r.type === "junco_chat_command");

    // ---- turn 1: the model drafts, the turn hook parks -----------------------
    expect((await post("prompt", { key, text: "draft a ticket" })).status).toBe(202);
    await waitFor(() => chatDrafts(sandbox).length === 1, {
      timeoutMs: 60_000,
      label: "draft parked",
    });
    const draftId = chatDrafts(sandbox)[0]!; // waitFor above proved there is one
    // Parked, not lint_failed: a lint failure would refuse the tool AND spend
    // the auto-lint retry turn (chatDrafts.ts's lintFollowUp).
    expect(records().some((r) => r.type === "junco_chat_draft" && r.status === "parked")).toBe(
      true,
    );

    // ---- turn 2: the SDK calls the tool, which blocks on the operator -------
    expect((await post("prompt", { key, text: "submit it" })).status).toBe(202);
    await waitFor(() => commands().some((c) => c.status === "proposed"), {
      timeoutMs: 60_000,
      label: "junco_chat_command proposed",
    });
    const proposed = commands().find((c) => c.status === "proposed");
    expect(proposed).toMatchObject({
      command: "submit",
      draftId,
      ids: [TICKET_ID],
      route: "inbox",
    });
    const commandId = proposed?.commandId ?? "";
    expect(commandId).not.toBe("");

    // The tool really is blocking: only turn 1 has ended, and nothing is queued.
    expect(records().filter((r) => r.type === "junco_chat_turn_end")).toHaveLength(1);
    expect(queueState(sandbox, TICKET_ID).dir).toBe(null);

    // ---- the handshake: a stale id is refused, the live one settles it ------
    expect((await post("decide", { key, commandId: "nope", decision: "run" })).status).toBe(409);
    expect((await post("decide", { key, commandId, decision: "run" })).status).toBe(202);
    await waitFor(() => commands().some((c) => c.status === "ran"), {
      timeoutMs: 60_000,
      label: "junco_chat_command ran",
    });
    expect(commands().find((c) => c.status === "ran")).toMatchObject({
      commandId,
      exitCode: 0,
      route: "inbox",
    });

    // ---- turn 3: the tool result goes back to the model, which finishes -----
    await waitFor(() => records().filter((r) => r.type === "junco_chat_turn_end").length === 2, {
      timeoutMs: 60_000,
      label: "the tool turn ended",
    });

    // The ticket the model drafted is queued, and the draft is archived.
    // `!== null` on purpose: `inbox` would additionally pin the scenario to
    // this daemon's `worker.pollIntervalSeconds: 3600` (nothing claims it
    // within the test's life). What is being asserted is that the CLI really
    // queued it — which survives a future wake-on-submit moving it straight
    // to processing/.
    expect(queueState(sandbox, TICKET_ID).dir).not.toBeNull();
    expect(chatDrafts(sandbox)).toEqual([]);
    const archived = chatDraftArchivePath(sandbox, draftId);
    expect(archived === null ? false : existsSync(archived)).toBe(true);
    expect(records().some((r) => r.type === "junco_chat_draft" && r.status === "submitted")).toBe(
      true,
    );

    // ---- what the WIRE proves about the SDK --------------------------------
    const reqs = chatRequests(sandbox);
    expect(stub(sandbox).exhausted).toBe(false);
    expect(reqs).toHaveLength(3);
    // The tool was offered to the model — i.e. the SDK registered the plain
    // object AND enabled it off the `tools` allowlist (spec §3.2).
    const offered = (i: number): string[] =>
      ((reqs[i]?.body?.tools ?? []) as Array<{ function: { name: string } }>).map(
        (t) => t.function.name,
      );
    expect(offered(1)).toContain("junco_submit");
    expect(
      offered(1)
        .filter((n) => n !== "junco_submit")
        .sort(),
    ).toEqual(["find", "grep", "ls", "read"]);
    // And its result came back through the SDK as the tool message of the
    // third request — the exact text spec §3.1 promises the model.
    expect(JSON.stringify(reqs[2]?.body ?? {})).toContain(
      `submitted → inbox · ${TICKET_ID} (exit 0)`,
    );

    // Nothing here touches GitHub: the inbox route spawns `junco submit <file>`
    // with no --as-issue, so the fake gh is never called (it has no catch-all,
    // so an unscripted call would also have failed loudly).
    expect(ghLog(sandbox)).toEqual([]);

    // A chat session with a settled tool call still drains cleanly on SIGTERM.
    daemon.child.kill("SIGTERM");
    expect((await daemon.exited).code).toBe(0);
  });
});
