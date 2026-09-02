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

  it("a non-2xx carries the daemon's own reason; a transport failure carries none (R32)", async () => {
    for (const [status, body, reason] of [
      [503, JSON.stringify({ error: "chat_disabled" }), "chat_disabled"],
      [404, JSON.stringify({ error: "unknown_key" }), "unknown_key"],
      [409, JSON.stringify({ error: "no_checkout" }), "no_checkout"],
      [403, "forbidden, not json", null],
    ] as const) {
      const fetchFn = (async () => new Response(body, { status })) as unknown as typeof fetch;
      const seen: Array<[string, string | null | undefined]> = [];
      const stop = subscribeChat(
        "k",
        0,
        { record: () => {}, status: (s, why) => seen.push([s, why]), end: () => {} },
        { fetchFn, baseUrl: "http://x", backoffMs: [1], sleep: async () => {} },
      );
      await new Promise((r) => setTimeout(r, 20));
      stop();
      expect(seen[seen.length - 1]).toEqual(["down", reason]);
    }
    // A transport failure says only "down": the dashboard must not render a
    // stale route reason for a daemon that never answered.
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const seen: Array<[string, string | null | undefined]> = [];
    const stop = subscribeChat(
      "k",
      0,
      { record: () => {}, status: (s, why) => seen.push([s, why]), end: () => {} },
      { fetchFn, baseUrl: "http://x", backoffMs: [1, 1, 1], sleep: async () => {} },
    );
    await new Promise((r) => setTimeout(r, 40));
    stop();
    const down = seen.filter(([s]) => s === "down");
    expect(down.length).toBeGreaterThan(0);
    expect(down.every(([, why]) => why === undefined || why === null)).toBe(true);
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

  it("a non-JSON body is returned as plain text rather than throwing", async () => {
    const fetchFn = (async () =>
      new Response("not json", { status: 500 })) as unknown as typeof fetch;
    const r = await postChat("abort", { key: "k" }, { fetchFn, baseUrl: "http://x" });
    expect(r).toEqual({ status: 500, body: "not json" });
  });
});
