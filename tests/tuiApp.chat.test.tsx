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
  chatDraft,
  chatPrompt,
  chatTurnAborted,
  chatTurnStart,
  metaLine,
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
   *  rail's OWN first row, so the §8.1 re-subscribe effect (the rail's key wins
   *  while the chat view is open) never swaps the session out from under the
   *  prefill. */
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

  // ── Ruling R7: the rail switches the session on a MOVE, not on a mismatch ──
  // `c` from an overlay legitimately opens a chat for a repo the rail is not
  // parked on; the old effect re-opened the rail's own session on the next
  // render and threw the prefilled composer away.

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
