/**
 * Tests for src/chat/chatRoutes.ts — /chat/* on the health server (spec
 * 2026-09-01 §5). SSE out, POST in, loopback-only auth boundary. Written
 * FIRST (TDD). Uses a real ephemeral server (`port: 0`) + global fetch.
 */
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
