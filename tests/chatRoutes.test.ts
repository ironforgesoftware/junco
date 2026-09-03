/**
 * Tests for src/chat/chatRoutes.ts — /chat/* on the health server (spec
 * 2026-09-01 §5). SSE out, POST in, loopback-only auth boundary. Written
 * FIRST (TDD). Uses a real ephemeral server (`port: 0`) + global fetch.
 */
import { describe, it, expect, afterEach } from "vitest";
import { request as httpRequest } from "node:http";
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
    subsCount: () => number;
  } = {
    calls,
    push: (line, off) => subs.forEach((s) => s.onLine(line, off)),
    end: () => subs.forEach((s) => s.onEnd("daemon_stopped")),
    subsCount: () => subs.size,
    enabled: () => true,
    prompt: async (...a) => (
      calls.push(["prompt", ...a]),
      { ok: true, value: { mode: "prompt", done: Promise.resolve() } }
    ),
    abort: async (...a) => (calls.push(["abort", ...a]), { ok: true, value: { aborted: true } }),
    fresh: async (...a) => (calls.push(["fresh", ...a]), { ok: true, value: null }),
    note: async (...a) => (calls.push(["note", ...a]), { ok: true, value: null }),
    decide: async (...a) => (
      calls.push(["decide", ...a]),
      { ok: true, value: { settled: a[1] === "live" } }
    ),
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

/** `fetch()` always derives `Host` from the URL — Node's `http.request` is
 *  the only way to send an arbitrary one, needed for the Host-allowlist
 *  tests below. */
function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? "GET",
        headers: opts.headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function waitUntil(cond: () => boolean, timeoutMs = 500, stepMs = 5): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
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

  it("POST /chat/prompt answers on ADMISSION — the turn's `done` is never awaited (R33)", async () => {
    // A turn can run for many minutes; undici's 300 s headersTimeout would
    // reject the dashboard's fetch long before a held-open response arrived.
    let endTurn!: () => void;
    let ended = false;
    const turn = new Promise<void>((r) => (endTurn = r)).then(() => {
      ended = true;
    });
    const url = await serve(
      fakeManager({ prompt: async () => ({ ok: true, value: { mode: "prompt", done: turn } }) }),
    );
    const r = await fetch(`${url}/chat/prompt`, {
      method: "POST",
      body: JSON.stringify({ key: "acme/api", text: "hi" }),
    });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ mode: "prompt" });
    expect(ended).toBe(false); // answered while the turn is still running
    endTurn();
    await turn;
  });

  it("gate-rejected prompt → 200 {mode:'rejected'}", async () => {
    const url = await serve(
      fakeManager({
        prompt: async () => ({ ok: true, value: { mode: "rejected", done: Promise.resolve() } }),
      }),
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

  it("POST /chat/note validates the record's shape, not just its type tag → 400", async () => {
    const m = fakeManager();
    const url = await serve(m);
    const ok = {
      type: "junco_chat_draft",
      draftId: "d1",
      kind: "ticket",
      status: "parked",
      ids: ["t"],
      destination: null,
    };
    const bad: unknown[] = [
      { ...ok, draftId: 7 },
      { ...ok, kind: "nonsense" },
      { ...ok, status: "maybe" },
      { ...ok, ids: "t" },
      { ...ok, ids: [1] },
      { ...ok, destination: 3 },
      { type: "junco_chat_draft" },
    ];
    for (const record of bad) {
      const r = await fetch(`${url}/chat/note`, {
        method: "POST",
        body: JSON.stringify({ key: "k", record }),
      });
      expect(r.status, JSON.stringify(record)).toBe(400);
    }
    // The whole shape is what reaches the transcript, so the valid one still passes.
    expect(
      (
        await fetch(`${url}/chat/note`, {
          method: "POST",
          body: JSON.stringify({ key: "k", record: ok }),
        })
      ).status,
    ).toBe(202);
    expect(m.calls.filter((c) => c[0] === "note")).toHaveLength(1);
  });

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

  it("no ping after `event: end` — the timer is disarmed synchronously", async () => {
    // A fast pingMs (e.g. 5ms) racing a real network round trip is flaky: the
    // server can legitimately write a second ping before the test's async
    // "observe one ping, then call end()" reaction reaches it — that write
    // predates cleanup() and isn't a bug. Instead, end the stream
    // immediately (long before a slow ping would ever fire), then wait
    // comfortably past where a wrongly-still-armed ping would have shown up.
    const m = fakeManager();
    const url = await serve(m, { pingMs: 200 });
    const resp = await fetch(`${url}/chat/events?key=k&since=100`);
    expect(resp.status).toBe(200);
    const reader = resp.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const events: string[] = [];
    const readOne = async (): Promise<boolean> => {
      const { value, done } = await reader.read();
      if (done) return false;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        events.push(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
      return true;
    };
    m.end(); // well under pingMs after subscribe — no ping could have fired yet
    while (events.length < 1) await readOne();
    expect(events[0]).toBe('event: end\ndata: {"reason":"daemon_stopped"}');
    // If the ping weren't disarmed, it would have fired by the 200ms mark —
    // wait comfortably past that and confirm no further bytes arrive. A
    // `done:true` read (the connection closing after res.end()) is expected
    // and not a failure; only actual data is.
    const raced = await Promise.race([
      readOne().then((gotData) => (gotData ? "more-data" : "stream-closed")),
      new Promise((r) => setTimeout(() => r("timeout"), 250)),
    ]);
    expect(raced).not.toBe("more-data");
    await reader.cancel();
  });

  it("POST /chat/abort → 204 when the manager reports aborted:false", async () => {
    const url = await serve(
      fakeManager({ abort: async () => ({ ok: true, value: { aborted: false } }) }),
    );
    const r = await fetch(`${url}/chat/abort`, {
      method: "POST",
      body: JSON.stringify({ key: "k" }),
    });
    expect(r.status).toBe(204);
  });

  it("a raw body over the default cap → 413 without JSON parsing", async () => {
    const url = await serve(fakeManager());
    const r = await fetch(`${url}/chat/prompt`, {
      method: "POST",
      body: JSON.stringify({ key: "k", text: "x".repeat(70 * 1024) }),
    });
    expect(r.status).toBe(413);
  });

  it("client disconnect cleans up the ping and the subscription", async () => {
    const m = fakeManager();
    const url = await serve(m);
    const resp = await fetch(`${url}/chat/events?key=k`);
    await waitUntil(() => m.subsCount() === 1);
    const reader = resp.body!.getReader();
    await reader.cancel();
    await waitUntil(() => m.subsCount() === 0);
    // Pushing after the subscriber is gone must be a harmless no-op.
    expect(() => m.push("noop", null)).not.toThrow();
  });

  it("setup-window: a client that disconnects while subscribe() is pending is still released once it resolves", async () => {
    let resolveSubscribe: () => void = () => {};
    const deferred = new Promise<void>((res) => {
      resolveSubscribe = res;
    });
    let unsubscribeCalls = 0;
    const m = fakeManager({
      subscribe: async () => {
        await deferred;
        return {
          ok: true,
          value: {
            replay: [],
            unsubscribe: () => {
              unsubscribeCalls++;
            },
          },
        };
      },
    });
    const url = await serve(m);
    const ac = new AbortController();
    const pending = fetch(`${url}/chat/events?key=k`, { signal: ac.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 20)); // reach the server; subscribe() is now pending
    ac.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 20)); // let the abort land server-side as 'close'
    resolveSubscribe();
    await waitUntil(() => unsubscribeCalls > 0);
    expect(unsubscribeCalls).toBe(1);
  });

  it("Last-Event-ID wins over the `since` query when both are present", async () => {
    const m = fakeManager();
    const url = await serve(m, { pingMs: 60_000 });
    const resp = await fetch(`${url}/chat/events?key=k&since=10`, {
      headers: { "last-event-id": "30" },
    });
    await readSse(resp, 0);
    expect(m.calls[0]).toEqual(["subscribe", "k", 30]);
  });

  it("POST /chat/status and POST /chat/events → 405", async () => {
    const url = await serve(fakeManager());
    expect((await fetch(`${url}/chat/status?key=k`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${url}/chat/events?key=k`, { method: "POST" })).status).toBe(405);
  });

  it("Host allowlist: an unrecognized Host header → 403", async () => {
    const url = await serve(fakeManager());
    const r = await rawRequest(`${url}/chat/status?key=k`, { headers: { host: "evil.example" } });
    expect(r.status).toBe(403);
  });

  it("Host allowlist: 127.0.0.1:<port> and localhost:<port> are allowed", async () => {
    const url = await serve(fakeManager());
    const port = new URL(url).port;
    const r1 = await rawRequest(`${url}/chat/status?key=k`, {
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(r1.status).toBe(200);
    const r2 = await rawRequest(`${url}/chat/status?key=k`, {
      headers: { host: `localhost:${port}` },
    });
    expect(r2.status).toBe(200);
  });

  it("Host allowlist: [::1]:<port> is allowed", async () => {
    const url = await serve(fakeManager());
    const port = new URL(url).port;
    const r = await rawRequest(`${url}/chat/status?key=k`, {
      headers: { host: `[::1]:${port}` },
    });
    expect(r.status).toBe(200);
  });

  it("Host allowlist: a configured `allowedHost` is accepted", async () => {
    const url = await serve(fakeManager(), { allowedHost: "chat.internal" });
    const port = new URL(url).port;
    const r = await rawRequest(`${url}/chat/status?key=k`, {
      headers: { host: `chat.internal:${port}` },
    });
    expect(r.status).toBe(200);
  });
});
