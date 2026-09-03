/**
 * The dashboard's side of /chat/* (spec 2026-09-01 §7): a stateful SSE
 * parser (partial-chunk safe), a reconnecting subscribe over the injectable
 * fetchFn that echoes Last-Event-ID, and the POST helpers. No Origin header
 * is ever sent — the daemon refuses any request that carries one (§5.3).
 */

export interface SseEvent {
  id: number | null;
  event: string | null;
  data: string;
}

export function makeSseParser(): { push(chunk: string): SseEvent[] } {
  let buf = "";
  return {
    push(chunk: string): SseEvent[] {
      buf += chunk;
      const out: SseEvent[] = [];
      let i: number;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let id: number | null = null;
        let event: string | null = null;
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) continue; // comment (": ping")
          const c = line.indexOf(":");
          const field = c === -1 ? line : line.slice(0, c);
          const value = c === -1 ? "" : line.slice(c + 1).replace(/^ /, "");
          if (field === "id") id = Number.parseInt(value, 10);
          else if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
        if (data.length > 0)
          out.push({ id: Number.isFinite(id as number) ? id : null, event, data: data.join("\n") });
      }
      return out;
    },
  };
}

export type ChatConnState = "connecting" | "live" | "reconnecting" | "down" | "ended";

export interface ChatSubscribeHandlers {
  record(offset: number | null, line: string): void;
  /** `reason` is the daemon's OWN word for a non-2xx refusal (chat_disabled,
   *  unknown_key, no_checkout, not_a_repo …, Ruling R32) — absent for a
   *  transport failure, which says nothing beyond "down". */
  status(s: ChatConnState, reason?: string | null): void;
  end(reason: string): void;
}

export interface ChatClientDeps {
  fetchFn?: typeof fetch;
  baseUrl: string;
  /** Reconnect delays; the last repeats. Default 500 ms → 5 s. */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 5000];
const DOWN_AFTER = 3;

/** The `{"error":"…"}` a refused /chat/* answer carries (chatRoutes.ts).
 *  Anything else — an empty body, HTML from a proxy, a body that cannot be
 *  read — is null, never a guess. */
async function errorReason(resp: Response): Promise<string | null> {
  try {
    const v: unknown = JSON.parse(await resp.text());
    const e = typeof v === "object" && v !== null ? (v as { error?: unknown }).error : undefined;
    return typeof e === "string" && e !== "" ? e : null;
  } catch {
    return null;
  }
}

export function subscribeChat(
  key: string,
  since: number | null,
  on: ChatSubscribeHandlers,
  deps: ChatClientDeps,
): () => void {
  const fetchFn = deps.fetchFn ?? fetch;
  const backoff = deps.backoffMs ?? DEFAULT_BACKOFF;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // A test's instant-resolve fake sleep (`async () => {}`) is a pure
  // microtask: chained with an all-microtask fetch/stream fake (no real
  // I/O), the reconnect loop never yields back to libuv, so real timers
  // (including the test's own) starve and the loop spins the CPU forever
  // (the daemon-loop gotcha in CLAUDE.md's testing section, generalized to
  // SSE reconnect). `Promise.all` with a genuine setImmediate macrotask
  // guarantees one real event-loop tick per reconnect attempt regardless of
  // what `sleep` does, while never shortening a real (production) backoff.
  const backoffTick = (ms: number): Promise<unknown> =>
    Promise.all([sleep(ms), new Promise<void>((r) => setImmediate(r))]);
  let stopped = false;
  let lastId: number | null = since;
  let ctrl: AbortController | null = null;

  const loop = async (): Promise<void> => {
    let failures = 0;
    let attempt = 0;
    on.status("connecting");
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const url = new URL("/chat/events", deps.baseUrl);
        url.searchParams.set("key", key);
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (lastId !== null) headers["last-event-id"] = String(lastId);
        const resp = await fetchFn(url, { headers, signal: ctrl.signal });
        if (!resp.ok || !resp.body) {
          // ANY non-2xx (or a 2xx with no body) is a daemon ANSWER, not a
          // transport failure: report down and stop — no retry storm against
          // e.g. a 503 chat_disabled or a 404 unknown_key (ruling R19). The
          // answer's own `error` rides along (R32) so the header can say WHY
          // instead of collapsing every refusal into "daemon down".
          on.status("down", resp.ok ? null : await errorReason(resp));
          return;
        }
        failures = 0;
        attempt = 0;
        on.status("live");
        const parser = makeSseParser();
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const ev of parser.push(dec.decode(value, { stream: true }))) {
            if (ev.event === "end") {
              let reason = "ended";
              try {
                reason = String((JSON.parse(ev.data) as { reason?: string }).reason ?? reason);
              } catch {
                /* keep default */
              }
              on.end(reason);
              on.status("ended");
              return;
            }
            if (ev.id !== null) lastId = ev.id;
            on.record(ev.id, ev.data);
          }
        }
        if (stopped) return;
        on.status("reconnecting");
      } catch (e) {
        if (stopped || (e as { name?: string }).name === "AbortError") return;
        failures++;
        on.status(failures >= DOWN_AFTER ? "down" : "reconnecting");
      }
      await backoffTick(backoff[Math.min(attempt++, backoff.length - 1)]!);
    }
  };
  void loop();
  return () => {
    stopped = true;
    ctrl?.abort();
  };
}

export async function postChat(
  path: "prompt" | "abort" | "new" | "note" | "decide",
  body: Record<string, unknown>,
  deps: ChatClientDeps,
): Promise<{ status: number; body: unknown }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const resp = await fetchFn(new URL(`/chat/${path}`, deps.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: resp.status, body: parsed };
}
