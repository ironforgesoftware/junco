/**
 * App-level chat wiring (spec 2026-09-01 §8.1/§8.3/§8.6, door key updated by
 * 2026-09-02 D5): the `c` door, the esc state machine, the blurred verbs and
 * the slash router. The chat-scroll brief (2026-09-02) removed the pane doors
 * and with them the rail's in-view re-subscribe, so the rail no longer steers
 * an open chat — only Ruling R7's "stays put" guarantee below is left of it.
 * Every domain piece has its own suite (useChat, useChatDrafts, ChatView,
 * Composer) — these exercise the COMPOSITION through real rendered frames.
 *
 * Keystroke discipline (CLAUDE.md + tests/helpers/until.ts): every write is
 * gated on an `until` that proves the previous one committed. The opening
 * gate waits for the ASYNC issue fetch, not the synchronous config repos, so
 * ink's own input-listener effect has certainly run before the first key.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  CHEAP,
  EMPTY_QUEUE,
  okv,
  renderApp,
  stubClient,
  tap,
  TO_QUEUE_ROW,
} from "./helpers/localFixtures.js";
import { makeDashPr } from "./helpers/dashFixtures.js";
import { githubTicketId } from "../src/githubInbox.js";
import { expandHome } from "../src/config.js";
import { until, fireUntil } from "./helpers/until.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { ChatSubscribeHandlers } from "../src/tui/chatClient.js";
import type { PendingDraft } from "../src/chat/draftStore.js";
import type { DashIssue } from "../src/tui/state.js";
import {
  chatCommand,
  chatDraft,
  chatPrompt,
  chatTurnAborted,
  chatTurnEnd,
  chatTurnStart,
  metaLine,
  turnEndFull,
} from "./helpers/transcriptFixtures.js";

const DRAFT: PendingDraft = {
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
};

function chatClient(): {
  client: DashboardClient;
  calls: string[];
  push: (offset: number | null, line: string) => void;
} {
  let h: ChatSubscribeHandlers | null = null;
  const calls: string[] = [];
  const client: DashboardClient = {
    ...stubClient,
    listChatDrafts: async () => ({ ok: true, value: [DRAFT] }),
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
  return { client, calls, push: (o, l) => h!.record(o, l) };
}

/** The async gate: ISSUES arrive from the stub's listIssues, so a frame that
 * shows one proves App's mount effects (ink's input listener among them) ran. */
const LOADED = "First issue";

describe("dashboard chat wiring (spec 2026-09-01 §8)", () => {
  it("c on a repo row opens the chat view with the composer focused; typed prose never fires mnemonics; enter sends", async () => {
    const c = chatClient();
    const r = renderApp({ client: c.client });
    await until(() => r.lastFrame()!.includes(LOADED));
    r.stdin.write("c");
    await until(() => r.lastFrame()!.includes("chat · acme/api"));
    r.stdin.write("quit"); // q would quit the dashboard if the mnemonic path saw it
    await until(() => r.lastFrame()!.includes("quit"));
    r.stdin.write("\r");
    await until(() => c.calls.includes("prompt:quit"));
    expect(r.lastFrame()).toContain("chat · acme/api");
  });

  it("esc: streaming → abort; idle+focused → blur; blurred → leave the view", async () => {
    const c = chatClient();
    const r = renderApp({ client: c.client });
    await until(() => r.lastFrame()!.includes(LOADED));
    r.stdin.write("c");
    await until(() => r.lastFrame()!.includes("chat · acme/api"));
    c.push(10, metaLine({ ticketId: "acme__api" }));
    c.push(20, chatPrompt());
    c.push(30, chatTurnStart());
    await until(() => r.lastFrame()!.includes("◐ streaming"));
    r.stdin.write("\x1b");
    await until(() => c.calls.includes("abort"));
    c.push(40, chatTurnAborted());
    await until(() => !r.lastFrame()!.includes("◐ streaming"));
    r.stdin.write("\x1b");
    await until(() => r.lastFrame()!.includes("i compose"));
    r.stdin.write("\x1b");
    await until(() => !r.lastFrame()!.includes("chat · acme/api"));
    expect(c.calls).toContain("unsub");
  });

  it("blurred: s submits the selected draft, i refocuses; the rail badge shows ● and the draft count", async () => {
    const c = chatClient();
    const ran: string[][] = [];
    const r = renderApp({
      client: c.client,
      // Ruling R3: the fixture default (999999) never delivers a second
      // health poll, and /health.chats is what feeds the rail badge.
      healthPollMs: 50,
      runCliFn: async (n, a) => (ran.push([n, ...a]), { code: 0, output: "", timedOut: false }),
    });
    await until(() => r.lastFrame()!.includes(LOADED));
    await until(() => r.lastFrame()!.includes("● 1▣"));
    r.stdin.write("c");
    await until(() => r.lastFrame()!.includes("chat · acme/api"));
    c.push(10, metaLine({ ticketId: "acme__api" }));
    c.push(20, chatDraft());
    await until(() => r.lastFrame()!.includes("draft parked"));
    r.stdin.write("\x1b"); // blur (idle)
    await until(() => r.lastFrame()!.includes("i compose"));
    await fireUntil(r.stdin, "s", () => ran.length === 1);
    expect(ran[0]![0]).toBe("submit");
    expect(ran[0]![1]).toMatch(/add-cache\.md$/);
    r.stdin.write("i");
    await until(() => r.lastFrame()!.includes("esc blur/abort"));
  });

  // QA 2026-09-03: every door forced pane 2 (the Composer's hook was gated on
  // it) and `close` restored only the view, so a chat opened from the rail
  // dropped you on the issue list.
  it("closing a chat opened from the rail returns to the rail, not the issue list", async () => {
    const c = chatClient();
    const r = renderApp({ client: c.client });
    await until(() => r.lastFrame()!.includes(LOADED));
    const railFooter = (): boolean => /→ {2}issues/.test(r.lastFrame() ?? ""); // pane 1's navigate row
    expect(railFooter()).toBe(true);
    r.stdin.write("c");
    await until(() => r.lastFrame()!.includes("chat · acme/api"));
    r.stdin.write("quit"); // typed prose still reaches the composer with no pane switch
    await until(() => r.lastFrame()!.includes("quit"));
    r.stdin.write("\x1b"); // blur
    await until(() => r.lastFrame()!.includes("i compose"));
    r.stdin.write("\x1b"); // leave
    await until(() => !r.lastFrame()!.includes("chat · acme/api"));
    expect(railFooter()).toBe(true);
  });

  // The live bug (QA 2026-09-03): with a card near the top and a long answer
  // below it, one ↑ from the tail jumped to the card and ↓ then did nothing —
  // bodyWindow re-nudged the window onto the cursor's anchor on every render.
  it("scroll keys move by rows; a card is revealed only by tab, and scrolls away again", async () => {
    const c = chatClient();
    const r = renderApp({ client: c.client });
    await until(() => r.lastFrame()!.includes(LOADED));
    r.stdin.write("c");
    await until(() => r.lastFrame()!.includes("chat · acme/api"));
    c.push(10, metaLine({ ticketId: "acme__api" }));
    // Turn 1 parks the card (the anchor, near the top); turn 2 is a long
    // answer that pushes the tail well below it.
    c.push(20, chatPrompt());
    c.push(30, chatTurnStart());
    c.push(40, chatDraft());
    c.push(50, chatTurnEnd());
    c.push(60, chatPrompt({ text: "and then?" }));
    c.push(70, chatTurnStart());
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 10}`);
    c.push(80, turnEndFull({ text: lines.join("\n") }));
    c.push(90, chatTurnEnd());
    await until(() => r.lastFrame()!.includes("line 49")); // following the tail
    expect(r.lastFrame()).not.toContain("draft parked"); // 40 rows: the card is off the top
    r.stdin.write("\x1b"); // blur
    await until(() => r.lastFrame()!.includes("i compose"));
    r.stdin.write("\x1b[A"); // ↑ — one row, NOT a jump to the card
    await until(() => !r.lastFrame()!.includes("line 49"));
    expect(r.lastFrame()).toContain("line 48");
    expect(r.lastFrame()).not.toContain("draft parked");
    r.stdin.write("\t"); // tab → the card: the one move that reveals it
    await until(() => r.lastFrame()!.includes("draft parked"));
    r.stdin.write("\x1b[B"); // ↓ — the card scrolls off again (the reveal was acked)
    await until(() => !r.lastFrame()!.includes("draft parked"));
  });

  // Spec 2026-09-03 §4: the whole card through real frames — the proposal
  // blurs the composer and takes the footer into `chatConfirm`, `y` POSTs the
  // decision, and the terminal record clears the card and leaves an
  // expandable row behind.
  it("a proposed junco_submit shows the card, blurs the composer, y decides, the terminal record clears it", async () => {
    const decisions: string[] = [];
    const ran: string[][] = [];
    const c = chatClient();
    c.client.chat.decide = async (_k, id, d) => (
      decisions.push(`${id}:${d}`),
      { ok: true, value: { settled: true } }
    );
    const r = renderApp({
      client: c.client,
      runCliFn: async (n, a) => (ran.push([n, ...a]), { code: 0, output: "", timedOut: false }),
    });
    await until(() => r.lastFrame()!.includes(LOADED));
    r.stdin.write("c");
    await until(() => r.lastFrame()!.includes("chat · acme/api"));
    c.push(10, metaLine({ ticketId: "acme__api" }));
    c.push(20, chatPrompt({ text: "submit it" }));
    c.push(30, chatTurnStart());
    c.push(40, chatCommand({ status: "proposed" }));
    // The card's own row says "y submit · n keep parked" too, so the FOOTER
    // (the frame's last two lines) is what proves the chatConfirm context.
    const footerActions = (): string => {
      const rows = (r.lastFrame() ?? "").trimEnd().split("\n");
      return rows[rows.length - 2] ?? "";
    };
    await until(() => footerActions().includes("keep parked"));
    expect(r.lastFrame()).toContain("awaiting you · y submit · n keep parked");
    expect(r.lastFrame()).toContain("◐ awaiting your confirmation");
    expect(footerActions()).toContain("y submit");
    expect(r.lastFrame()).not.toContain("esc blur/abort"); // composer blurred
    // The draft verbs are OFF the keymap while the daemon holds this draft:
    // `s` must not submit the parked draft a second time (the `y` round trip
    // below is the bounded window a buggy dispatch would have landed in).
    r.stdin.write("s");
    r.stdin.write("y");
    await until(() => decisions.length === 1);
    expect(decisions).toEqual(["call_1:run"]);
    expect(ran).toEqual([]);
    c.push(50, chatCommand({ status: "ran", exitCode: 0, output: "queued add-readme" }));
    c.push(60, chatTurnEnd());
    await until(() => r.lastFrame()!.includes("✓ submitted → inbox · add-readme · exit 0"));
    // Answered (fix round 1, ruling R2): the tail and the composer come back,
    // so the footer is the composer's own row — not the confirm one.
    await until(() => r.lastFrame()!.includes("esc blur/abort"));
    expect(footerActions()).not.toContain("keep parked");
    r.stdin.write("\x1b"); // blur again to reach the card's keys
    await until(() => footerActions().includes("thinking"));
    r.stdin.write("\r"); // ⏎ on the card expands the CLI output
    await until(() => r.lastFrame()!.includes("queued add-readme"));
  });

  it("/pr N injects the fetched context as a user message; /abort maps to its verb", async () => {
    const c = chatClient();
    const r = renderApp({ client: c.client });
    await until(() => r.lastFrame()!.includes(LOADED));
    r.stdin.write("c");
    await until(() => r.lastFrame()!.includes("chat · acme/api"));
    r.stdin.write("/pr 42");
    await until(() => r.lastFrame()!.includes("/pr 42"));
    r.stdin.write("\r");
    await until(() =>
      c.calls.some((x) => x.startsWith("prompt:") && x.includes("PR #42: Add cache")),
    );
    // R32: the composer empties only once the POST is accepted, so wait for
    // it — typing into a box that still holds "/pr 42" builds "/pr 42/abort".
    await until(() => !r.lastFrame()!.includes("/pr 42"));
    r.stdin.write("/abort");
    await until(() => r.lastFrame()!.includes("/abort"));
    r.stdin.write("\r");
    await until(() => c.calls.includes("abort"));
  });
});

/**
 * The chat verb end to end (spec 2026-09-02 §5, D6/D7): `c` opens the chat for
 * whatever repo the surface is about, with the issue/PR thread already TYPED in
 * the composer — and nothing sent. Every keystroke is `until`-gated on the
 * previous one's committed frame (CLAUDE.md's Ink discipline).
 *
 * Pane markers: the issue list's chip row is the only one carrying
 * "investigate" (ISSUES_CHIP_ORDER's `analyze`), so it gates pane 2 — and its
 * absence, after that, gates the step onto pane 3.
 */
describe("the chat verb (spec 2026-09-02 §5)", () => {
  const ISSUE_46: DashIssue = {
    number: 46,
    title: "First issue",
    labels: ["junco"],
    updatedAt: "2026-07-06T10:00:00Z",
    url: "https://github.com/acme/api/issues/46",
    author: null,
  };
  const PR_12 = makeDashPr({ number: 12, nwo: "acme/api" });
  const PR_7_BETA = makeDashPr({ number: 7, nwo: "beta/two" });
  const TICKET_46 = githubTicketId("acme/api", 46);

  /** chatClient + one issue (#46) and one PR (#12), both on acme/api — the
   *  rail's OWN first row, which is also where the prefill cases expect the
   *  session to be (nothing re-subscribes an open chat any more: the
   *  chat-scroll brief removed the pane doors and the rail-switch effect with
   *  them, so a chat stays on the repo it was opened for). */
  function verbClient() {
    const c = chatClient();
    return {
      ...c,
      client: {
        ...c.client,
        listIssues: async () => okv({ issues: [ISSUE_46], staleAt: null }),
        listPrs: async () => okv({ prs: [PR_12], staleAt: null }),
      } as DashboardClient,
    };
  }

  const frame = (r: ReturnType<typeof renderApp>): string => r.lastFrame() ?? "";
  /** The ▌ cursor on the row carrying `text` — the body-focus settled signal. */
  const selOn = (r: ReturnType<typeof renderApp>, text: string): boolean =>
    frame(r)
      .split("\n")
      .some((l) => l.includes(text) && l.includes("▌"));

  it("c on the issue list opens the repo chat with /issue N typed, and sends nothing", async () => {
    const c = verbClient();
    const r = renderApp({ client: c.client });
    await until(() => frame(r).includes(LOADED));
    r.stdin.write("l"); // pane 2 — the issue list
    await until(() => frame(r).includes("investigate"));
    r.stdin.write("c");
    await until(() => frame(r).includes("chat · acme/api"));
    await until(() => frame(r).includes("/issue 46"));
    expect(c.calls.filter((x) => x.startsWith("prompt:"))).toEqual([]);
  });

  it("c on pane 3 prefills the selected PR's thread", async () => {
    const c = verbClient();
    const r = renderApp({ client: c.client });
    await until(() => frame(r).includes(LOADED));
    r.stdin.write("l");
    await until(() => frame(r).includes("investigate"));
    r.stdin.write("l"); // pane 3 — the PR list drops the issue verbs
    await until(() => !frame(r).includes("investigate"));
    r.stdin.write("c");
    await until(() => frame(r).includes("chat · acme/api"));
    await until(() => frame(r).includes("/pr 12"));
  });

  it("c inside the issue-detail overlay prefills the same thread (D7)", async () => {
    const c = verbClient();
    const r = renderApp({ client: c.client });
    await until(() => frame(r).includes(LOADED));
    r.stdin.write("l");
    await until(() => frame(r).includes("investigate"));
    r.stdin.write("\r"); // enter — the issue-detail overlay
    await until(() => frame(r).includes("(no plan posted yet)"));
    r.stdin.write("c");
    await until(() => frame(r).includes("chat · acme/api"));
    await until(() => frame(r).includes("/issue 46"));
  });

  it("c with no repo in context toasts and stays put", async () => {
    const c = verbClient();
    const r = renderApp({ client: c.client });
    await until(() => frame(r).includes(LOADED));
    await tap(r, TO_QUEUE_ROW); // rail → the queue system row
    await until(() => frame(r).includes("sub-fix-typos"));
    r.stdin.write("l"); // into the queue body
    await until(() => selOn(r, "#1 exec"));
    r.stdin.write("c");
    await until(() => frame(r).includes("select a repo first"));
    expect(frame(r)).not.toContain("chat · ");
  });

  // #330's key, re-verified from the surface the chat verb now shares: `t` is
  // the issue list's transcript, `c` its chat — neither shadows the other. The
  // transcript then carries the issue's repo, so `c` there chats about it (D7).
  it("t on the issue list still opens the ticket transcript, whose own c chats about the repo", async () => {
    const c = verbClient();
    const r = renderApp({
      client: c.client,
      queueFn: async () => ({
        ...EMPTY_QUEUE,
        running: [
          {
            id: TICKET_46,
            github: { nwo: "acme/api", issue: 46, kind: "pr" as const, external: false },
            turns: 1,
            lastTool: null,
            outputTokens: null,
            startedAt: "2026-07-07T10:00:00Z",
            updatedAt: null,
            stale: false,
            repoPath: null,
          },
        ],
      }),
    });
    await until(() => frame(r).includes(LOADED));
    r.stdin.write("l");
    await until(() => frame(r).includes("investigate"));
    r.stdin.write("t");
    await until(() => frame(r).includes("transcript ▸"));
    expect(frame(r)).toContain(TICKET_46);
    r.stdin.write("c");
    await until(() => frame(r).includes("chat · acme/api"));
  });

  // ── Ruling R7, now absolute: the rail never switches an open chat's session ──
  // R7 narrowed the old effect from "any mismatch" to "a rail MOVE"; the
  // chat-scroll brief deleted the effect outright with the pane doors. `c` from
  // an overlay opens a chat for a repo the rail is not parked on, and it stays
  // there — the old behaviour re-opened the rail's own session on the very next
  // render and threw the prefilled composer away. These two cases are what
  // stops that regression coming back.

  /** chatClient + a per-repo PR stub (only beta/two has one, so the PRs view's
   *  single row is the NON-rail repo and needs no cursor move), a subscribe log,
   *  and a health-poll counter — the "nothing happened afterwards" clock. */
  function railClient() {
    const base = chatClient();
    const subs: string[] = [];
    const state = { healths: 0 };
    const client: DashboardClient = {
      ...base.client,
      listIssues: async () => okv({ issues: [ISSUE_46], staleAt: null }),
      listPrs: async (nwo) => okv({ prs: nwo === "beta/two" ? [PR_7_BETA] : [], staleAt: null }),
      health: async () => (state.healths++, base.client.health()),
      chat: {
        ...base.client.chat,
        subscribe: (k, _s, on) => (subs.push(k), on.status("live"), () => {}),
      },
    };
    return { client, subs, state };
  }

  it("a chat opened from the PRs view for a NON-rail repo stays put (R7)", async () => {
    const c = railClient();
    const r = renderApp({ client: c.client, healthPollMs: 20 });
    await until(() => frame(r).includes(LOADED));
    r.stdin.write("p"); // the PRs view — one row, beta/two#7 (the rail is on acme/api)
    await until(() => frame(r).includes("Test PR #7"));
    r.stdin.write("c");
    await until(() => frame(r).includes("chat · beta/two"));
    await until(() => frame(r).includes("/pr 7"));
    // Two more health polls' worth of renders: the pre-R7 effect re-subscribed
    // to the rail's repo on the very next one and wiped the prefill.
    const seen = c.state.healths;
    await until(() => c.state.healths >= seen + 2);
    expect(c.subs).toEqual(["beta/two"]);
    expect(frame(r)).toContain("chat · beta/two");
    expect(frame(r)).toContain("/pr 7");
  });

  it("c on the rail still opens the rail repo's session exactly once (R7)", async () => {
    const c = railClient();
    const r = renderApp({ client: c.client, healthPollMs: 20 });
    await until(() => frame(r).includes(LOADED));
    r.stdin.write("c");
    await until(() => frame(r).includes("chat · acme/api"));
    const seen = c.state.healths;
    await until(() => c.state.healths >= seen + 2);
    expect(c.subs).toEqual(["acme/api"]);
  });

  // The queue row's transcript chats about the TICKET's repo, keyed the way
  // src/chat/chatKey.ts defines the key (Ruling R13): the watched nwo when the
  // row carries one, the resolved checkout path only for a local-only row, and
  // nothing at all for a Q&A ticket with neither.
  /** CHEAP's running row with its GitHub side removed — a local-only ticket. */
  const localRow = (repoPath: string | null) => ({
    ...CHEAP.queue.running[0]!,
    github: null,
    repoPath,
  });
  const withRunning = (row: (typeof CHEAP.queue.running)[number]) => ({
    ...CHEAP,
    queue: { ...CHEAP.queue, running: [row] },
  });
  /** rail → queue row → into the body → enter on the running row → its
   * transcript. The row label is `#N exec` for a bridged ticket (queueFmt) and
   * the bare id otherwise. */
  async function openQueueTranscript(
    r: ReturnType<typeof renderApp>,
    rowLabel: string,
  ): Promise<void> {
    await until(() => frame(r).includes(LOADED));
    await tap(r, TO_QUEUE_ROW);
    await until(() => frame(r).includes("sub-fix-typos"));
    r.stdin.write("l");
    await until(() => selOn(r, rowLabel));
    r.stdin.write("\r");
    await until(() => frame(r).includes("transcript ▸"));
  }

  it("a LOCAL-ONLY queue row's transcript chats about its checkout, and toasts when it has none", async () => {
    const c = verbClient();
    const r = renderApp({
      client: c.client,
      localCheapFn: async () => withRunning(localRow("/c/api")),
    });
    await openQueueTranscript(r, "gh-acme-api-1");
    r.stdin.write("c");
    await until(() => frame(r).includes("chat · /c/api"));

    const bare = verbClient();
    const r2 = renderApp({
      client: bare.client,
      localCheapFn: async () => withRunning(localRow(null)),
    });
    await openQueueTranscript(r2, "gh-acme-api-1");
    r2.stdin.write("c");
    await until(() => frame(r2).includes("select a repo first"));
  });

  // QueueRow.repoPath is the ticket's raw `repo:` frontmatter — may be `~/…`
  // or relative — and must be normalised the same way every other consumer
  // resolves it (runOnce.ts / repoContext.ts), not passed through verbatim.
  it("a queue-row transcript normalises a ~-relative repoPath before chatting about it", async () => {
    const c = verbClient();
    const r = renderApp({
      client: c.client,
      localCheapFn: async () => withRunning(localRow("~/dev/foo")),
    });
    await openQueueTranscript(r, "gh-acme-api-1");
    r.stdin.write("c");
    await until(() => frame(r).includes(`chat · ${resolve(expandHome("~/dev/foo"))}`));
  });

  // Ruling R13: chatKey.ts keys a WATCHED repo by nwo. A bridged ticket's row
  // carries both a `github.nwo` and a checkout path — often an external-fork
  // clone under the clones dir, which is not a chattable repo at all
  // (`not_a_repo`). Keying by the path opened a SECOND session beside the
  // rail's nwo one, for the same repo.
  it("a bridged queue row's transcript chats about its nwo, not its clone path (R13)", async () => {
    const bridged = {
      ...CHEAP.queue.running[0]!,
      id: TICKET_46,
      github: { nwo: "acme/api", issue: 46, kind: "pr" as const, external: true },
      repoPath: "/x/state/repos/acme-api-fork",
    };
    const c = verbClient();
    const r = renderApp({
      client: c.client,
      localCheapFn: async () => withRunning(bridged),
    });
    await openQueueTranscript(r, "#46 exec");
    r.stdin.write("c");
    await until(() => frame(r).includes("chat · acme/api"));
    expect(frame(r)).not.toContain("acme-api-fork");
  });

  // …and the two doors to that one transcript must land on that one session:
  // `t` on the issue list (openIssueTranscript, which has always keyed by nwo)
  // and `enter` on the queue row (queueTranscriptOpts).
  it("both doors to a ticket's transcript reach the SAME chat key (R13)", async () => {
    const bridged = {
      ...CHEAP.queue.running[0]!,
      id: TICKET_46,
      github: { nwo: "acme/api", issue: 46, kind: "pr" as const, external: false },
      repoPath: "/c/api",
    };
    const props = {
      queueFn: async () => ({ ...EMPTY_QUEUE, running: [bridged] }),
      localCheapFn: async () => withRunning(bridged),
    };

    const viaIssue = renderApp({ client: verbClient().client, ...props });
    await until(() => frame(viaIssue).includes(LOADED));
    viaIssue.stdin.write("l");
    await until(() => frame(viaIssue).includes("investigate"));
    viaIssue.stdin.write("t");
    await until(() => frame(viaIssue).includes("transcript ▸"));
    viaIssue.stdin.write("c");
    await until(() => frame(viaIssue).includes("chat · "));
    const keyLine = frame(viaIssue)
      .split("\n")
      .find((l) => l.includes("chat · "))!;

    const viaQueue = renderApp({ client: verbClient().client, ...props });
    await openQueueTranscript(viaQueue, "#46 exec");
    viaQueue.stdin.write("c");
    await until(() => frame(viaQueue).includes("chat · "));
    expect(
      frame(viaQueue)
        .split("\n")
        .find((l) => l.includes("chat · ")),
    ).toBe(keyLine);
    expect(keyLine).toContain("chat · acme/api");
  });
});
