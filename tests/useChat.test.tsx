import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useChat, CHAT_RING } from "../src/tui/hooks/useChat.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { ChatSubscribeHandlers } from "../src/tui/chatClient.js";
import { anchorIds } from "../src/transcriptSummary.js";
import { stubClient } from "./helpers/localFixtures.js";
import { until, wait } from "./helpers/until.js";
import {
  chatDraft,
  chatPrompt,
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
}: {
  client: DashboardClient;
  onReady: (api: ReturnType<typeof useChat>) => void;
  ringSize?: number;
  resubscribeMs?: number;
}) {
  const aliveRef = React.useRef(true);
  const api = useChat({ client, aliveRef, flushMs: 5, ringSize, resubscribeMs });
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

  // Fix round 1 (MINOR 1): junco_chat_turn_aborted (liveText cleared,
  // ||-combined with turn_end) and junco_chat_transcript_degraded (degraded:
  // true) were untested branches.
  it("turn_aborted clears live text/streaming; transcript_degraded sets degraded", async () => {
    const c = makeClient();
    let api!: ReturnType<typeof useChat>;
    render(<Probe client={c.client} onReady={(a) => (api = a)} />);
    api.openChat("acme/api");
    await until(() => api.chat?.connection === "live");
    c.push(10, chatTurnStart());
    c.push(
      null,
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      }),
    );
    await until(() => api.chat!.liveText === "hi");
    c.push(20, chatTurnAborted());
    await until(() => api.chat!.streaming === false);
    expect(api.chat!.liveText).toBe("");
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

    // moveCursor's clamp branch: jump past the end, clamp to the last anchor.
    api.moveCursor(5);
    await until(() => api.chat!.cursor === 1);
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
    await until(() => api.chat!.showThinking === true);

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
