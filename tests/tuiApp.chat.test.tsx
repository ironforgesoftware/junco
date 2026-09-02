/**
 * App-level chat wiring (spec 2026-09-01 §8.1/§8.3/§8.6, door key updated by
 * 2026-09-02 D5): the `c` door, the esc state machine, the blurred verbs, the
 * slash router, and the rail's re-subscribe. Every domain piece has its own
 * suite (useChat, useChatDrafts, ChatView, Composer) — these five exercise
 * the COMPOSITION through real rendered frames.
 *
 * Keystroke discipline (CLAUDE.md + tests/helpers/until.ts): every write is
 * gated on an `until` that proves the previous one committed. The opening
 * gate waits for the ASYNC issue fetch, not the synchronous config repos, so
 * ink's own input-listener effect has certainly run before the first key.
 */
import { describe, it, expect } from "vitest";
import { renderApp, stubClient } from "./helpers/localFixtures.js";
import { until, fireUntil, tick } from "./helpers/until.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { ChatSubscribeHandlers } from "../src/tui/chatClient.js";
import type { PendingDraft } from "../src/chat/draftStore.js";
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

  it("the rail stays the nav spine: it re-subscribes on a move, and i hands the focus back to the chat", async () => {
    // localFixtures watches acme/api then beta/two (TO_QUEUE_ROW = "jj"
    // documents the rail order), so one rail step down lands on beta/two.
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
    await until(() => r.lastFrame()!.includes(LOADED));
    r.stdin.write("c");
    await until(() => r.lastFrame()!.includes("chat · acme/api"));
    r.stdin.write("\x1b"); // blur the composer (idle)
    await until(() => r.lastFrame()!.includes("i compose"));
    // `h` (focus the rail) paints nothing of its own: the chat view is
    // full-screen (spec §8.1), so pane 1 has no widget on screen, the view's
    // chips are pane-independent, and ChatView's accent→border flip is
    // invisible here — chalk sees ink-testing-library's non-TTY stdout and
    // writes no color, so the frame is plain text (verified: the pane-1 and
    // pane-2 frames are byte-identical). The RE-SUBSCRIBE is the observable,
    // so drive both keys until it lands: `h` is idempotent once pane 1 holds
    // the focus, and a dropped `h` leaves `j` a no-op (no records ⇒ no
    // anchors ⇒ moveCursor cannot move) rather than a wrong move.
    // The retry is gated on `subs` — pushed synchronously by the re-subscribe
    // the rail move triggers — NOT on the frame: `j` is not idempotent, and a
    // slow runner that has already moved the rail but not yet repainted would
    // otherwise take a second step past beta/two.
    for (let i = 0; i < 40 && subs.length === 1; i++) {
      r.stdin.write("h");
      await tick();
      r.stdin.write("j");
      for (let k = 0; k < 5 && subs.length === 1; k++) await tick();
    }
    await until(() => r.lastFrame()!.includes("chat · beta/two"));
    expect(subs).toEqual(["acme/api", "beta/two"]);
    // The re-subscribe re-opened the session, so `composerFocused` is true
    // again while pane 1 still holds the focus — ChatView's Composer is
    // inactive there. `i` must hand the pane back with the focus, or every
    // key is swallowed by a hook that isn't listening and only esc recovers.
    r.stdin.write("i");
    await until(() => r.lastFrame()!.includes("esc blur/abort"));
    r.stdin.write("z");
    await until(() => r.lastFrame()!.includes("z█")); // the cursor block only renders when active
  });
});
