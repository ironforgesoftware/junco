import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useChat, CHAT_RING, overflowBatch } from "../src/tui/hooks/useChat.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { ChatSubscribeHandlers } from "../src/tui/chatClient.js";
import { anchorIds, commandAnchor, summarizeTranscript } from "../src/transcriptSummary.js";
import { okv, stubClient } from "./helpers/localFixtures.js";
import { until, wait } from "./helpers/until.js";
import {
  chatCommand,
  chatDelta,
  chatDraft,
  chatPartial,
  chatPrompt,
  chatTool,
  chatTurnAborted,
  chatTurnEnd,
  chatTurnStart,
  chatTurnRejected,
  metaLine,
  turnEndFull,
  toolStartId,
  toolEndId,
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
    status: (s: Parameters<ChatSubscribeHandlers["status"]>[0], reason?: string | null) =>
      handlers!.status(s, reason),
    end: (r: string) => handlers!.end(r),
  };
}

/** Ruling R21's tests need per-call visibility into `since` and the exact
 * handlers object the hook registered for each subscribe attempt (including
 * a resubscribe), so this tracks every call instead of just the latest. */
function makeResubClient(drafts: unknown[] = []) {
  const subscribeCalls: (number | null)[] = [];
  const handlersLog: ChatSubscribeHandlers[] = [];
  const client: DashboardClient = {
    ...stubClient,
    listChatDrafts: async () => ({ ok: true, value: drafts as never }),
    chat: {
      ...stubClient.chat,
      subscribe: (_key, since, on) => {
        subscribeCalls.push(since);
        handlersLog.push(on);
        on.status("live");
        return () => {};
      },
      prompt: async () => ({ ok: true, value: { mode: "prompt" as const } }),
      abort: async () => ({ ok: true, value: { aborted: true } }),
      fresh: async () => ({ ok: true, value: null }),
    },
  };
  return { client, subscribeCalls, handlersLog };
}

/** Fix round 1 (IMPORTANT): a resubscribe must run the outgoing
 * subscription's cleanup — the only thing that calls the transport's
 * ctrl.abort() (chatClient.ts's `end` path returns without aborting) —
 * before subscribing again. Tracks one ordered event log across
 * subscribe/unsubscribe calls so the ordering itself is assertable. */
function makeOrderedClient() {
  const events: string[] = [];
  const handlersLog: ChatSubscribeHandlers[] = [];
  let n = 0;
  const client: DashboardClient = {
    ...stubClient,
    listChatDrafts: async () => ({ ok: true, value: [] as never }),
    chat: {
      ...stubClient.chat,
      subscribe: (_key, _since, on) => {
        n++;
        const id = n;
        events.push(`subscribe#${id}`);
        handlersLog.push(on);
        on.status("live");
        return () => events.push(`unsub#${id}`);
      },
      prompt: async () => ({ ok: true, value: { mode: "prompt" as const } }),
      abort: async () => ({ ok: true, value: { aborted: true } }),
      fresh: async () => ({ ok: true, value: null }),
    },
  };
  return { client, events, handlersLog };
}

function Probe({
  client,
  onReady,
  ringSize,
  resubscribeMs,
  onSummaryRebuild,
}: {
  client: DashboardClient;
  onReady: (api: ReturnType<typeof useChat>) => void;
  ringSize?: number;
  resubscribeMs?: number;
  onSummaryRebuild?: (ringLength: number) => void;
}) {
  const aliveRef = React.useRef(true);
  const api = useChat({ client, aliveRef, ringSize, resubscribeMs, onSummaryRebuild });
  onReady(api);
  // The live turn as one line: text/thinking blocks by their text, tool
  // blocks by `[name]`, in block order — the shape spec 2026-09-06 §3.1 keeps.
  const live =
    api.chat?.live?.blocks.map((b) => (b.kind === "tool" ? `[${b.name}]` : b.text)).join("|") ?? "";
  return (
    <Text>
      {api.chat
        ? `${api.chat.connection}:${api.chat.streaming ? "streaming" : "idle"}:${live}`
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
    c.push(30, chatTurnStart({ turn: "t1" }));
    c.push(null, chatDelta({ turn: "t1", seq: 1, delta: "beca" }));
    c.push(null, chatDelta({ turn: "t1", seq: 2, delta: "use" }));
    await until(() => r.lastFrame()!.includes("live:streaming:because"));
    expect(api.chat!.live!.turn).toBe("t1");
    expect(api.chat!.live!.seq).toBe(2);
    // A flush bumps `frame` — the memo key the live rows re-render on.
    expect(api.chat!.frame).toBeGreaterThan(0);
    expect(api.chat!.summary!.runs[0]!.prompt).toBe("why is the build slow?");
    c.push(
      40,
      turnEndFull({ thinking: null, text: "because", calls: [], usage: { input: 1, output: 1 } }),
    );
    c.push(50, chatTurnEnd());
    await until(() => r.lastFrame()!.includes("live:idle:"));
    expect(api.chat!.live).toBeNull();
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
    // A send re-follows the tail: the operator has just written the newest
    // row and must see it, however far back they had scrolled to read.
    api.setFollow(false);
    await until(() => api.chat!.follow === false);
    await api.send("hello");
    expect(c.calls).toContain("prompt:hello");
    await until(() => api.chat!.composer === "" && api.chat!.follow === true);
    c.push(60, chatTurnRejected());
    await until(() => api.chat!.blocked?.reason === "rate limited");
    await api.abort();
    await api.fresh();
    expect(c.calls).toEqual(expect.arrayContaining(["abort", "fresh"]));
  });

  // Spec 2026-09-02 §5 (the chat verb): `c` from a surface with an issue/PR in
  // view opens the repo's chat with the thread already TYPED — prefilled and
  // focused, never sent. The operator still owns the send key.
  it("openChat with a composer prefill lands the text in the composer, focused, and sends nothing", async () => {
    const c = makeClient();
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api", { composer: "/issue 46" });
    await until(() => api.chat?.composer === "/issue 46");
    expect(api.chat!.composerFocused).toBe(true);
    expect(c.calls.filter((x) => x.startsWith("prompt:"))).toEqual([]);
  });

  // R32's restore ref is written by every composer writer — the prefill
  // included. Out of sync, the first failed POST would restore the ref's stale
  // "" over the prefilled thread and swallow it silently.
  it("a prefill keeps R32's restore ref in sync: a failed send puts the prefilled text back", async () => {
    const c = makeClient({ prompt: async () => ({ ok: false as const, error: "no_checkout" }) });
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api", { composer: "/pr 12" });
    await until(() => api.chat?.composer === "/pr 12");
    await api.send("/pr 12");
    await until(() => api.chat?.error === "no_checkout");
    expect(api.chat!.composer).toBe("/pr 12");
  });

  it("a failed send keeps the operator's text, raises `error`, and clearError clears it (R32)", async () => {
    const c = makeClient({
      prompt: async () => ({ ok: false as const, error: "no_checkout" }),
    });
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    api.setComposer("a long message the operator typed");
    await api.send("a long message the operator typed");
    // Loop, don't tick: `api` is only refreshed by a commit (CLAUDE.md's Ink rule).
    await until(() => api.chat!.error === "no_checkout");
    // Clearing before the POST threw the text away on every failure.
    expect(api.chat!.composer).toBe("a long message the operator typed");
    api.clearError();
    await until(() => api.chat!.error === null);
  });

  it("keeps the daemon's own down reason, and drops it once the stream is live again (R32)", async () => {
    const c = makeClient();
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    c.status("down", "chat_disabled");
    await until(() => api.chat!.connection === "down");
    expect(api.chat!.downReason).toBe("chat_disabled");
    c.status("live");
    await until(() => api.chat!.connection === "live");
    expect(api.chat!.downReason).toBeNull();
    // A transport failure names no reason: nothing stale may survive it.
    c.status("down");
    await until(() => api.chat!.connection === "down");
    expect(api.chat!.downReason).toBeNull();
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

  // Ruling R2: ring size is injectable — push 25 records into a 20-slot ring
  // instead of CHAT_RING + 5 into a 2000-slot one (each push re-summarizes
  // the whole ring, so the default size would cost seconds for one
  // assertion). Keeps the default resubscribeMs (1000ms) so the
  // endReason === "daemon_stopped" assertion below cannot race a resubscribe
  // before closeChat cancels the pending timer.
  it("the ring keeps the last ringSize records and flags overflow; end/status propagate; close unsubscribes", async () => {
    const c = makeClient();
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} ringSize={20} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    for (let i = 0; i < 25; i++)
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

  it("CHAT_RING pins the default ring size", () => {
    expect(CHAT_RING).toBe(2000);
  });

  // Ruling R21: the hook owns re-subscription after a terminal `end`.
  it("session_reset ends → state resets and the hook resubscribes from offset 0", async () => {
    const draft = {
      id: "acme__api-20260901-130000-1",
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
    const { client, subscribeCalls, handlersLog } = makeResubClient([draft]);
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={client} onReady={(a) => (api = a)} resubscribeMs={5} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    await until(() => api.chat!.drafts.length === 1);
    handlersLog[0]!.record(10, metaLine());
    handlersLog[0]!.record(20, chatPrompt());
    handlersLog[0]!.record(30, chatTurnStart());
    await until(() => api.chat!.lastOffset === 30);
    api.setComposer("draft text");
    await until(() => api.chat!.composer === "draft text");
    handlersLog[0]!.end("session_reset");
    // The resubscribe timer issues the state reset (a React commit, async)
    // and THEN calls subscribe (synchronous, observable at once) — gate on the
    // committed state, not on the subscribe call, or a loaded runner reads the
    // pre-reset summary (this flaked the macOS gate on PR #445).
    await until(() => subscribeCalls.length === 2 && api.chat?.summary === null);
    expect(subscribeCalls[1]).toBeNull();
    expect(api.chat!.summary).toBeNull();
    expect(api.chat!.lastOffset).toBeNull();
    expect(api.chat!.endReason).toBe("session_reset");
    expect(api.chat!.composer).toBe("draft text");
    expect(api.chat!.drafts.length).toBe(1);
    handlersLog[1]!.record(40, chatTurnStart());
    await until(() => api.chat!.endReason === null);
  });

  it("a resubscribe unsubscribes the outgoing subscription before subscribing again", async () => {
    const { client, events, handlersLog } = makeOrderedClient();
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={client} onReady={(a) => (api = a)} resubscribeMs={5} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    handlersLog[0]!.end("daemon_stopped");
    await until(() => events.length === 3);
    expect(events).toEqual(["subscribe#1", "unsub#1", "subscribe#2"]);
  });

  it("daemon_stopped ends → resubscribes from the last offset", async () => {
    const { client, subscribeCalls, handlersLog } = makeResubClient();
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={client} onReady={(a) => (api = a)} resubscribeMs={5} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    handlersLog[0]!.record(10, metaLine());
    handlersLog[0]!.record(20, chatPrompt());
    handlersLog[0]!.record(30, chatTurnStart());
    await until(() => api.chat!.lastOffset === 30);
    const summaryBefore = api.chat!.summary;
    handlersLog[0]!.end("daemon_stopped");
    // Same gate discipline as the session_reset case: `endReason` is a commit.
    await until(() => subscribeCalls.length === 2 && api.chat?.endReason === "daemon_stopped");
    expect(subscribeCalls[1]).toBe(30);
    expect(api.chat!.summary).toBe(summaryBefore);
    expect(api.chat!.endReason).toBe("daemon_stopped");
  });

  it("closeChat cancels a pending resubscribe", async () => {
    const { client, subscribeCalls, handlersLog } = makeResubClient();
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={client} onReady={(a) => (api = a)} resubscribeMs={50} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    handlersLog[0]!.end("daemon_stopped");
    api.closeChat();
    await wait(80);
    expect(subscribeCalls.length).toBe(1);
  });

  it("stale handlers from a closed subscription are inert", async () => {
    const { client, handlersLog } = makeResubClient();
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    api.closeChat();
    await until(() => api.chat === null);
    handlersLog[0]!.status("live");
    handlersLog[0]!.record(10, metaLine());
    expect(api.chat).toBeNull();
  });

  // Fix round 1 (MINOR 1): junco_chat_turn_aborted (live turn cleared,
  // ||-combined with turn_end) and junco_chat_transcript_degraded (degraded:
  // true) were untested branches.
  it("turn_aborted clears live text/streaming; transcript_degraded sets degraded", async () => {
    const c = makeClient();
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    c.push(10, chatTurnStart());
    c.push(null, chatDelta({ seq: 1, delta: "hi" }));
    await until(() => {
      const b = api.chat!.live?.blocks[0];
      return b?.kind === "text" && b.text === "hi";
    });
    c.push(20, chatTurnAborted());
    await until(() => api.chat!.streaming === false);
    expect(api.chat!.live).toBeNull();
    // No fixture builder for this record — built inline per the review note.
    c.push(
      30,
      JSON.stringify({
        type: "junco_chat_transcript_degraded",
        ts: "2026-08-16T00:00:00.000Z",
      }),
    );
    await until(() => api.chat!.degraded === true);
  });

  // Spec 2026-09-06 §3.2/§3.5: the live turn is a block list scoped to the
  // turn id; a `junco_chat_partial` (sent first on subscribe) replaces it
  // wholesale, and every delta already applied is dropped by `seq`.
  describe("live turn (spec 2026-09-06 §3)", () => {
    it("a partial replaces the live blocks, and a delta at or below the applied seq is dropped", async () => {
      const c = makeClient();
      let api!: ReturnType<typeof useChat>;
      const r = render(<Probe client={c.client} onReady={(a) => (api = a)} />);
      api.openChat("acme/api");
      await until(() => api.chat?.connection === "live");
      c.push(10, chatTurnStart({ turn: "t1" }));
      c.push(null, chatDelta({ turn: "t1", seq: 1, delta: "old" }));
      await until(() => r.lastFrame()!.includes(":old"));
      c.push(
        null,
        chatPartial({
          turn: "t1",
          seq: 5,
          blocks: [
            { kind: "text", contentIndex: 0, text: "snap" },
            {
              kind: "tool",
              id: "c1",
              name: "read",
              args: {},
              output: "",
              result: null,
              isError: false,
              truncated: false,
              done: true,
            },
          ],
        }),
      );
      await until(() => r.lastFrame()!.includes(":snap|[read]"));
      expect(api.chat!.live!.seq).toBe(5);
      // Replayed after the snapshot: seq 5 and below are already applied.
      c.push(null, chatDelta({ turn: "t1", seq: 5, delta: "DUP" }));
      c.push(null, chatDelta({ turn: "t1", seq: 3, delta: "DUP" }));
      c.push(null, chatDelta({ turn: "t1", seq: 6, delta: "!" }));
      await until(() => r.lastFrame()!.includes(":snap!|[read]"));
      expect(r.lastFrame()).not.toContain("DUP");
      expect(api.chat!.live!.seq).toBe(6);
    });

    it("a delta for another turn is dropped", async () => {
      const c = makeClient();
      let api!: ReturnType<typeof useChat>;
      const r = render(<Probe client={c.client} onReady={(a) => (api = a)} />);
      api.openChat("acme/api");
      await until(() => api.chat?.connection === "live");
      c.push(10, chatTurnStart({ turn: "t2" }));
      c.push(null, chatDelta({ turn: "t1", seq: 1, delta: "stale" }));
      c.push(null, chatDelta({ turn: "t2", seq: 1, delta: "fresh" }));
      await until(() => r.lastFrame()!.includes(":fresh"));
      expect(r.lastFrame()).not.toContain("stale");
      expect(api.chat!.live!.turn).toBe("t2");
      expect(api.chat!.live!.blocks).toHaveLength(1);
    });

    it("a turn start without a `turn` id scopes the live turn by its ts", async () => {
      const c = makeClient();
      let api!: ReturnType<typeof useChat>;
      const r = render(<Probe client={c.client} onReady={(a) => (api = a)} />);
      api.openChat("acme/api");
      await until(() => api.chat?.connection === "live");
      const line = JSON.parse(chatTurnStart()) as Record<string, unknown>;
      delete line.turn;
      c.push(10, JSON.stringify(line));
      c.push(null, chatDelta({ turn: line.ts as string, seq: 1, delta: "by-ts" }));
      await until(() => r.lastFrame()!.includes(":by-ts"));
      expect(api.chat!.live!.turn).toBe(line.ts);
    });

    it("a thinking delta lands in a thinking block, ahead of the text at the same index; a tool record adds a tool block", async () => {
      const c = makeClient();
      let api!: ReturnType<typeof useChat>;
      const r = render(<Probe client={c.client} onReady={(a) => (api = a)} />);
      api.openChat("acme/api");
      await until(() => api.chat?.connection === "live");
      c.push(10, chatTurnStart({ turn: "t1" }));
      c.push(null, chatDelta({ turn: "t1", seq: 1, kind: "thinking", delta: "hmm" }));
      c.push(null, chatDelta({ turn: "t1", seq: 2, kind: "text", delta: "so" }));
      c.push(null, chatTool({ turn: "t1", seq: 3, id: "c1", phase: "start", name: "grep" }));
      await until(() => r.lastFrame()!.includes(":hmm|so|[grep]"));
      const blocks = api.chat!.live!.blocks;
      expect(blocks[0]).toMatchObject({ kind: "thinking", text: "hmm", done: true });
      expect(blocks[1]).toMatchObject({ kind: "text", text: "so" });
      expect(blocks[2]).toMatchObject({ kind: "tool", id: "c1", name: "grep", done: false });
    });

    it("toggleThinking flips thinking.pinned and nothing else", async () => {
      const c = makeClient();
      let api!: ReturnType<typeof useChat>;
      render(<Probe client={c.client} onReady={(a) => (api = a)} />);
      api.openChat("acme/api");
      await until(() => api.chat?.connection === "live");
      expect(api.chat!.thinking).toEqual({ pinned: false });
      api.toggleThinking();
      await until(() => api.chat!.thinking.pinned === true);
      api.toggleThinking();
      await until(() => api.chat!.thinking.pinned === false);
    });

    it("session_reset clears the live turn along with the summary", async () => {
      const { client, subscribeCalls, handlersLog } = makeResubClient();
      let api!: ReturnType<typeof useChat>;
      const r = render(<Probe client={client} onReady={(a) => (api = a)} resubscribeMs={5} />);
      api.openChat("acme/api");
      await until(() => api.chat?.connection === "live");
      handlersLog[0]!.record(10, chatTurnStart({ turn: "t1" }));
      handlersLog[0]!.record(null, chatDelta({ turn: "t1", seq: 1, delta: "mid" }));
      await until(() => r.lastFrame()!.includes(":mid"));
      handlersLog[0]!.end("session_reset");
      await until(() => subscribeCalls.length === 2 && api.chat?.summary === null);
      expect(api.chat!.live).toBeNull();
      // The pending accumulator went too: a stale-turn delta after the reset
      // has nothing to land in.
      handlersLog[1]!.record(null, chatDelta({ turn: "t1", seq: 2, delta: "ghost" }));
      handlersLog[1]!.record(20, metaLine());
      await until(() => api.chat!.summary !== null);
      expect(api.chat!.live).toBeNull();
    });
  });

  // Spec 2026-09-06 §4.4: a live tool card's expansion lives in
  // `live.expanded`; the card keeps it when the turn ends because the finished
  // turn's card carries the same tool-call id.
  describe("live tool cards (spec 2026-09-06 §4.4)", () => {
    it("toggleExpanded on a live tool id flips live.expanded; the cursor reaches the live card; the expansion survives the turn end", async () => {
      const c = makeClient();
      let api!: ReturnType<typeof useChat>;
      const r = render(<Probe client={c.client} onReady={(a) => (api = a)} />);
      api.openChat("acme/api");
      await until(() => api.chat?.connection === "live");
      c.push(10, metaLine({ ticketId: "acme__api" }));
      c.push(20, chatPrompt());
      c.push(30, chatTurnStart({ turn: "t1" }));
      c.push(null, chatTool({ turn: "t1", seq: 1, id: "c1", phase: "start", name: "read" }));
      await until(() => r.lastFrame()!.includes("[read]"));
      // The explicit id (the `x` verb's path).
      api.toggleExpanded("c1");
      await until(() => api.chat!.live!.expanded.has("c1"));
      expect(api.chat!.expanded.size).toBe(0); // the finished set is untouched
      // A flush after the toggle keeps it: the pending accumulator does not
      // own `expanded`.
      c.push(null, chatTool({ turn: "t1", seq: 2, id: "c1", phase: "output", output: "L1\n" }));
      await until(() => (api.chat!.live!.blocks[0] as { output: string }).output === "L1\n");
      expect(api.chat!.live!.expanded.has("c1")).toBe(true);
      // The cursor-based path (enter/space) lands on the live card: it is the
      // only anchor, so a move from the tail stays on it.
      api.moveCursor(1);
      await until(() => api.chat!.follow === false);
      expect(api.chat!.cursor).toBe(0);
      api.toggleExpanded();
      await until(() => !api.chat!.live!.expanded.has("c1"));
      api.toggleExpanded();
      await until(() => api.chat!.live!.expanded.has("c1"));
      // Turn end: the finished turn arrives with the same id, and the card is
      // still open — `live.expanded` merged into `expanded`.
      c.push(null, chatTool({ turn: "t1", seq: 3, id: "c1", phase: "end", result: "L1" }));
      c.push(
        40,
        turnEndFull({ text: "", calls: [{ id: "c1", name: "read", args: {}, result: "L1" }] }),
      );
      c.push(50, chatTurnEnd());
      await until(() => api.chat!.live === null);
      expect(api.chat!.expanded.has("c1")).toBe(true);
      expect(api.chat!.cursor).toBe(0);
      // And the finished card toggles through the same call.
      api.toggleExpanded("c1");
      await until(() => !api.chat!.expanded.has("c1"));
    });
  });

  // Spec 2026-09-06 §3.3: the summary is extended one record at a time, and
  // a ring overflow recomputes from the ring — either way the result must be
  // what a whole-ring recompute gives, before, at, and after the overflow.
  // #510: an overflow splices `overflowBatch(ringSize)` oldest lines at once
  // (2 for a ring of 20), so the ring the summary covers is modelled here the
  // same way and checked against the hook's `onSummaryRebuild` seam.
  it("the incremental summary equals a whole-ring recompute across an overflow", async () => {
    const c = makeClient();
    let api!: ReturnType<typeof useChat>;
    const ringSize = 20;
    const batch = overflowBatch(ringSize);
    expect(batch).toBe(2);
    const rebuilds: number[] = [];
    render(
      <Probe
        client={c.client}
        onReady={(a) => (api = a)}
        ringSize={ringSize}
        onSummaryRebuild={(n) => rebuilds.push(n)}
      />,
    );
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    const lines: string[] = [];
    // The ring as the hook keeps it: one splice of `batch` when it overflows.
    const ring: string[] = [];
    const push = (line: string): void => {
      lines.push(line);
      ring.push(line);
      if (ring.length > ringSize) ring.splice(0, ring.length - ringSize + batch - 1);
      expect(ring.length).toBeLessThanOrEqual(ringSize);
      c.push(lines.length, line);
    };
    push(metaLine());
    push(chatPrompt());
    push(chatTurnStart());
    for (let i = 0; i < 8; i++) {
      push(toolStartId(`c${i}`, "read", { path: `f${i}` }));
      push(toolEndId(`c${i}`, "read", "ok"));
    }
    await until(() => api.chat!.lastOffset === lines.length);
    expect(api.chat!.overflowed).toBe(false);
    expect(api.chat!.summary).toEqual(summarizeTranscript(ring));
    expect(rebuilds).toEqual([]);
    // Line 20 fills the ring exactly — still incremental, not yet an overflow.
    push(chatTurnEnd());
    await until(() => api.chat!.lastOffset === lines.length);
    expect(lines.length).toBe(20);
    expect(api.chat!.overflowed).toBe(false);
    expect(api.chat!.summary).toEqual(summarizeTranscript(ring));
    expect(rebuilds).toEqual([]);
    // Line 21 splices `batch` lines off the head: ONE whole-ring recompute,
    // leaving the ring `batch - 1` short of full.
    push(chatPrompt({ text: "again" }));
    await until(() => api.chat!.overflowed === true);
    expect(rebuilds).toEqual([ringSize - batch + 1]);
    expect(api.chat!.summary).toEqual(summarizeTranscript(ring));
    // Line 22 refills the ring incrementally — no rebuild; line 23 overflows
    // again. Two more records, one rebuild — not one per record.
    push(chatTurnStart());
    await until(() => api.chat!.lastOffset === lines.length);
    expect(rebuilds).toEqual([ringSize - batch + 1]);
    expect(api.chat!.summary).toEqual(summarizeTranscript(ring));
    push(toolStartId("c99", "grep", { q: "x" }));
    await until(() => api.chat!.lastOffset === lines.length);
    expect(rebuilds).toEqual([ringSize - batch + 1, ringSize - batch + 1]);
    expect(api.chat!.summary).toEqual(summarizeTranscript(ring));
    expect(api.chat!.streaming).toBe(true);
    // Steady state: `batch` pushes per rebuild, the summary always the ring's,
    // `overflowed` sticky, `lastOffset` tracking the newest record.
    for (let i = 0; i < 3 * batch; i++) {
      push(toolEndId(`c99-${i}`, "grep", "ok"));
      await until(() => api.chat!.lastOffset === lines.length);
      expect(api.chat!.summary).toEqual(summarizeTranscript(ring));
      expect(api.chat!.overflowed).toBe(true);
    }
    expect(rebuilds).toHaveLength(2 + 3);
    expect(rebuilds.every((n) => n === ringSize - batch + 1)).toBe(true);
  });

  it("overflowBatch is a tenth of the ring, at least one", () => {
    expect(overflowBatch(CHAT_RING)).toBe(200);
    expect(overflowBatch(20)).toBe(2);
    expect(overflowBatch(19)).toBe(1);
    expect(overflowBatch(1)).toBe(1);
  });

  // Spec 2026-09-03 §4.1: a proposed junco_submit IS the operator's card — it
  // blurs the composer, parks the cursor on the card's anchor and owes the
  // window a reveal, so a confirmation can never be missed off-screen. The
  // terminal record clears `pending` and reloads the drafts (the daemon
  // archived the one it submitted).
  it("a proposed junco_submit sets pending, blurs the composer, parks the cursor; a terminal record clears it", async () => {
    const c = makeClient();
    let listCalls = 0;
    c.client.listChatDrafts = async () => (listCalls++, { ok: true, value: [] });
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    await until(() => listCalls === 1);
    c.push(10, metaLine());
    c.push(20, chatPrompt());
    c.push(30, chatTurnStart());
    api.focusComposer(true);
    await until(() => api.chat!.composerFocused === true);
    c.push(70, chatCommand({ status: "proposed" }));
    await until(() => api.chat!.pending?.commandId === "call_1");
    expect(api.chat!.pending).toEqual({
      commandId: "call_1",
      draftId: "acme__api-20260901-120000-1",
      ids: ["add-readme"],
      route: "inbox",
      running: false,
    });
    expect(api.chat!.composerFocused).toBe(false);
    expect(anchorIds(api.chat!.summary!)[api.chat!.cursor]).toBe(commandAnchor("call_1"));
    expect(api.chat!.reveal).toBe(true);
    expect(api.chat!.follow).toBe(false);
    c.push(80, chatCommand({ status: "ran", exitCode: 0, output: "queued add-readme" }));
    await until(() => api.chat!.pending === null);
    await until(() => listCalls === 2); // the drafts list reloaded
    // ⏎ on the card expands the CLI output: the `draft:` early return is a
    // draft-card rule, and a `cmd:` anchor has a body to show.
    api.toggleExpanded();
    await until(() => api.chat!.expanded.has(commandAnchor("call_1")));
  });

  // #478: between the operator's `y` and the CLI's exit the card must stop
  // saying "awaiting you" — and must not be answerable a second time.
  it("a running junco_submit keeps the card, marks it running, and disarms decide", async () => {
    const decided: string[] = [];
    const c = makeClient({
      decide: async (_k, _id, d) => (decided.push(d), okv({ settled: true })),
    });
    let listCalls = 0;
    c.client.listChatDrafts = async () => (listCalls++, { ok: true, value: [] });
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    await until(() => listCalls === 1);
    c.push(10, metaLine());
    c.push(20, chatPrompt({ text: "submit it" }));
    c.push(30, chatTurnStart());
    c.push(40, chatCommand({ status: "proposed" }));
    await until(() => api.chat!.pending?.commandId === "call_1");
    c.push(50, chatCommand({ status: "running" }));
    await until(() => api.chat!.pending?.running === true);
    expect(api.chat!.pending).toEqual({
      commandId: "call_1",
      draftId: "acme__api-20260901-120000-1",
      ids: ["add-readme"],
      route: "inbox",
      running: true,
    });
    expect(api.chat!.composerFocused).toBe(false);
    // Not a terminal record: no drafts reload, and y/n no longer POST.
    expect(listCalls).toBe(1);
    await api.decide("run");
    expect(decided).toEqual([]);
    await until(() => api.chat!.error === "that submit is already running");
    // The CLI's own record still settles it the usual way.
    c.push(60, chatCommand({ status: "ran", exitCode: 0, output: "queued" }));
    await until(() => api.chat!.pending === null);
    await until(() => listCalls === 2);
  });

  // Fix round 1 (controller ruling R2): the client fires status("live") BEFORE
  // the replayed lines, so the reducer cannot tell a replayed proposal from a
  // live one. Opening a chat whose history holds an answered card used to park
  // the view on it — follow paused, composer blurred, TranscriptBody nudging
  // onto the stale anchor. The settling record gives both back.
  it("a replayed proposed+terminal pair leaves the tail followed and the composer focused", async () => {
    const c = makeClient();
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    // Back-to-back, the way a replayed transcript delivers them.
    c.push(10, metaLine());
    c.push(20, chatPrompt({ text: "submit it" }));
    c.push(30, chatTurnStart());
    c.push(40, chatCommand({ status: "proposed" }));
    c.push(50, chatCommand({ status: "declined", detail: "operator declined" }));
    c.push(60, chatTurnEnd());
    await until(() => api.chat!.summary !== null && api.chat!.pending === null);
    await until(() => api.chat!.follow === true);
    expect(api.chat!.composerFocused).toBe(true);
    // The card is still reachable — the cursor was left where the proposal put
    // it, and `reveal` is the view's to ack as usual.
    expect(anchorIds(api.chat!.summary!)[api.chat!.cursor]).toBe(commandAnchor("call_1"));
  });

  it("decide() posts the pending command's id; a stale decision surfaces as an error", async () => {
    const decisions: string[] = [];
    const c = makeClient({
      decide: async (_k, id, d) => (
        decisions.push(`${id}:${d}`),
        okv({ settled: decisions.length === 1 })
      ),
    });
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    // Nothing open, nothing pending: decide() is a no-op, never a POST.
    await api.decide("run");
    expect(decisions).toEqual([]);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    await api.decide("run");
    expect(decisions).toEqual([]);
    c.push(10, metaLine());
    c.push(20, chatCommand({ status: "proposed" }));
    await until(() => api.chat!.pending !== null);
    await api.decide("run");
    expect(decisions).toEqual(["call_1:run"]);
    // The daemon had nothing pending under that id (another dashboard won the
    // race, or it expired): `settled: false` is not an error result, but it is
    // the operator's error to see.
    await api.decide("decline");
    await until(() => api.chat!.error === "that confirmation is no longer pending");
  });

  // Coverage: walk every remaining callback branch through one transcript
  // that has a tool call (for an expandable anchor) and a draft note (for
  // the draft-anchor guard), plus the withKey/reloadDrafts failure paths.
  it("walks composer/cursor/expand/thinking/follow callbacks and the withKey/reloadDrafts failure branches", async () => {
    const draft = {
      id: "acme__api-20260901-120000-9",
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
    const c = makeClient({ prompt: async () => ({ ok: false, error: "boom" }) }, [draft]);
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} />);

    // reloadDrafts: key === null early return (nothing open yet).
    await api.reloadDrafts();
    expect(api.chat).toBeNull();

    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    await until(() => api.chat!.drafts.length === 1);

    c.push(10, metaLine());
    await until(() => api.chat!.summary !== null);
    // moveCursor's n === 0 branch: summary exists, no anchors yet. A true
    // no-op — `follow` included. It used to drop follow regardless, which on
    // an anchor-less Q&A chat (where `tab` is the cursor key now) unpinned the
    // window from the tail and, with a never-scrolled offset of 0, jumped the
    // view to the top of the conversation.
    expect(api.chat!.follow).toBe(true);
    api.moveCursor(1);
    // Negative assertion: give a (buggy) state update a bounded window to land.
    await new Promise((r) => setTimeout(r, 40));
    expect(api.chat!.cursor).toBe(0);
    expect(api.chat!.follow).toBe(true);

    c.push(20, toolStartId("tool-1", "read", { path: "x" }));
    c.push(30, toolEndId("tool-1", "read", "ok"));
    c.push(40, chatDraft());
    await until(() => (api.chat!.summary ? anchorIds(api.chat!.summary).length === 2 : false));

    // A move OUT OF FOLLOW steps from the last anchor, not the stale cursor
    // (useTranscript's rule): shift+tab from the tail lands on the card
    // nearest it — here anchor 0 of 2, one back from the last.
    expect(api.chat!.reveal).toBe(false);
    api.moveCursor(-1);
    await until(() => api.chat!.follow === false);
    expect(api.chat!.cursor).toBe(0);
    // A move that lands owes the window a reveal (the view nudges onto the
    // anchor once, then acks); the n === 0 no-op above owed nothing.
    expect(api.chat!.reveal).toBe(true);
    api.ackReveal();
    await until(() => api.chat!.reveal === false);
    // moveCursor's clamp branch: jump past the end, clamp to the last anchor.
    api.moveCursor(5);
    await until(() => api.chat!.cursor === 1);
    expect(api.chat!.reveal).toBe(true);
    api.ackReveal();
    await until(() => api.chat!.reveal === false);
    // toggleExpanded's draft-anchor early return: no-op on a draft anchor.
    api.toggleExpanded();
    expect(api.chat!.expanded.size).toBe(0);

    api.moveCursor(-5);
    await until(() => api.chat!.cursor === 0);
    // toggleExpanded add/remove on a tool-call anchor.
    api.toggleExpanded();
    await until(() => api.chat!.expanded.has("tool-1"));
    api.toggleExpanded();
    await until(() => !api.chat!.expanded.has("tool-1"));

    api.toggleThinking();
    await until(() => api.chat!.thinking.pinned === true);
    api.toggleThinking();
    await until(() => api.chat!.thinking.pinned === false);

    api.setComposer("draft text");
    await until(() => api.chat!.composer === "draft text");
    api.focusComposer(false);
    await until(() => api.chat!.composerFocused === false);

    // send() with blank text is a no-op — no prompt POST.
    await api.send("   ");
    expect(c.calls.some((x) => x.startsWith("prompt:"))).toBe(false);

    // withKey's !r.ok → error path (client.chat.prompt above always fails).
    api.setComposer("hi");
    await api.send("hi");
    await until(() => api.chat!.error === "boom");

    // reloadDrafts's !r.ok early return.
    c.client.listChatDrafts = async () => ({ ok: false, error: "nope" });
    await api.reloadDrafts();
    expect(api.chat!.drafts.length).toBe(1);
  });
});
