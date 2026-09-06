/**
 * /chat/* on the health server (spec 2026-09-01 §5): SSE out, POST in, and
 * the auth boundary — loopback-only regardless of healthHost, a Host-header
 * allowlist (closes a DNS-rebinding read of GET /chat/events: a page whose
 * hostname has been rebound to 127.0.0.1 is same-origin with the daemon, so
 * its GET carries no Origin), and any request carrying an Origin header
 * refused (a browser always sends one cross-origin; the TUI never does).
 * All three checks run before any other work, on every /chat/* path. Every
 * response is JSON except the event stream.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatManager, ChatError } from "./chatManager.js";
import {
  DRAFT_DESTINATIONS,
  DRAFT_KINDS,
  DRAFT_STATUSES,
  type ChatDraftRecord,
} from "../agent/transcriptSchema.js";

export type ChatRoutesManager = Pick<
  ChatManager,
  "enabled" | "prompt" | "abort" | "fresh" | "note" | "decide" | "subscribe" | "status"
>;

export interface ChatRoutes {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export interface ChatRoutesDeps {
  isLoopback?: (req: IncomingMessage) => boolean;
  /** SSE keep-alive comment cadence (default 15 s). */
  pingMs?: number;
  /** Prompt text cap (default 64 KiB) → 413. */
  maxTextBytes?: number;
  /** Extra Host-header value to allow beyond localhost/127.0.0.1/::1 — the
   *  daemon's configured `healthHost` when it binds loopback under a name
   *  other than those three. Absent → only the three fixed values pass. */
  allowedHost?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackRequest(req: IncomingMessage): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? "");
}

const FIXED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Strip a trailing `:port` and unwrap an IPv6 `[...]` literal, lowercased.
 *  `null` for a missing header — treated as not-allowed, never as a pass. */
function normalizeHost(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? null : h.slice(1, end).toLowerCase();
  }
  const idx = h.lastIndexOf(":");
  return (idx === -1 ? h : h.slice(0, idx)).toLowerCase();
}

function isHostAllowed(req: IncomingMessage, allowedHost: string | undefined): boolean {
  const host = normalizeHost(req.headers.host);
  if (host === null) return false;
  if (FIXED_HOSTS.has(host)) return true;
  return allowedHost !== undefined && host === allowedHost.toLowerCase();
}

const STATUS: Record<ChatError, number> = {
  unknown_key: 404,
  no_checkout: 409,
  not_a_repo: 409,
  chat_disabled: 503,
  // The daemon is shutting down (#446): the manager refuses the prompt rather
  // than let it rebuild the SDK session drain() just disposed.
  draining: 503,
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(s),
    "cache-control": "no-store",
  });
  res.end(s);
}

async function readBody(
  req: IncomingMessage,
  max: number,
): Promise<{ ok: true; text: string } | { ok: false; status: 413 }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > max) return { ok: false, status: 413 };
    chunks.push(b);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Built from transcriptSchema's arrays, which the `DraftKind` /
// `ChatDraftRecord` unions are themselves derived from (#447): the sets and
// the types cannot drift, so a new draft kind reaches this validator by
// construction instead of answering 400 for a record the schema accepts.
const KIND_SET: ReadonlySet<string> = new Set<string>(DRAFT_KINDS);
const STATUS_SET: ReadonlySet<string> = new Set<string>(DRAFT_STATUSES);
const DESTINATION_SET: ReadonlySet<string> = new Set<string>(DRAFT_DESTINATIONS);

/** The whole `junco_chat_draft` shape, not just its type tag: this record is
 *  appended verbatim to the transcript, and `junco transcript` (plus the
 *  dashboard's own summarizer) reads its fields back. A malformed one from a
 *  buggy client would sit in the file forever. */
function draftRecord(v: unknown): Omit<ChatDraftRecord, "ts"> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const ok =
    r.type === "junco_chat_draft" &&
    typeof r.draftId === "string" &&
    r.draftId !== "" &&
    typeof r.kind === "string" &&
    KIND_SET.has(r.kind) &&
    typeof r.status === "string" &&
    STATUS_SET.has(r.status) &&
    Array.isArray(r.ids) &&
    r.ids.every((x) => typeof x === "string") &&
    (r.destination === null ||
      (typeof r.destination === "string" && DESTINATION_SET.has(r.destination)));
  return ok ? (v as Omit<ChatDraftRecord, "ts">) : null;
}

export function makeChatRoutes(manager: ChatRoutesManager, deps: ChatRoutesDeps = {}): ChatRoutes {
  const isLoopback = deps.isLoopback ?? isLoopbackRequest;
  const pingMs = deps.pingMs ?? 15_000;
  const maxTextBytes = deps.maxTextBytes ?? 64 * 1024;
  const allowedHost = deps.allowedHost;

  const sse = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const key = url.searchParams.get("key");
    if (!key) return json(res, 400, { error: "missing key" });
    // A reconnecting client's Last-Event-ID reflects what it actually saw;
    // its URL's `since` query may still carry the value from its FIRST
    // connect, so the header wins whenever both are present.
    const sinceRaw = req.headers["last-event-id"] ?? url.searchParams.get("since");
    const since = Number.parseInt(typeof sinceRaw === "string" ? sinceRaw : "0", 10);

    // Registered BEFORE `manager.subscribe()` is awaited: session creation +
    // ensureMeta is disk I/O that can be slow, and a client that disconnects
    // during that window must still be released once subscribe resolves —
    // attaching these listeners only after the await would arm the ping (and
    // leave the subscriber registered) on an already-destroyed response,
    // forever, since nothing would ever clear them again.
    let ping: NodeJS.Timeout | null = null;
    let unsubscribe: (() => void) | null = null;
    let cleaned = false;
    const cleanup = (): void => {
      cleaned = true;
      if (ping) {
        clearInterval(ping);
        ping = null;
      }
      // `unsubscribe` is still null on a close that lands while subscribe()
      // is in flight; the post-await check below calls cleanup() again once
      // it's set, and re-running these idempotent steps is harmless.
      unsubscribe?.();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);

    // Buffered until headers are sent: `manager.subscribe()` can invoke
    // `onLine`/`onEnd` before we get a chance to `writeHead` (a synchronous
    // callback from the subscribe call itself, or a concurrent publish
    // racing the same await) — an unbuffered `res.write` there would send an
    // implicit 200/chunked response missing the SSE content-type, and the
    // later explicit `writeHead` would then throw ERR_HTTP_HEADERS_SENT.
    const pending: string[] = [];
    let ended = false;
    const onLine = (line: string, offset: number | null): void => {
      if (res.writableEnded) return;
      const data = line.endsWith("\n") ? line.slice(0, -1) : line;
      const frame = offset === null ? `data: ${data}\n\n` : `id: ${offset}\ndata: ${data}\n\n`;
      if (res.headersSent) res.write(frame);
      else pending.push(frame);
    };
    const onEnd = (reason: string): void => {
      if (res.writableEnded) return;
      const frame = `event: end\ndata: ${JSON.stringify({ reason })}\n\n`;
      if (res.headersSent) {
        res.write(frame);
        res.end();
        cleanup();
      } else {
        pending.push(frame);
        ended = true;
      }
    };

    const r = await manager.subscribe(key, Number.isFinite(since) && since > 0 ? since : 0, {
      onLine,
      onEnd,
    });
    if (!r.ok) {
      cleanup();
      return json(res, STATUS[r.error], { error: r.error });
    }
    unsubscribe = r.value.unsubscribe;
    if (cleaned || res.destroyed || res.writableEnded) {
      // The client (or the stream itself, via onEnd above) was already gone
      // before subscribe() resolved. cleanup() ran earlier with `unsubscribe`
      // still null, so this call is what actually releases it — exactly once.
      cleanup();
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // Node buffers headers until the first body write; an empty replay would
    // otherwise leave a client's fetch() awaiting a response that never
    // arrives, so flush explicitly.
    res.flushHeaders();
    for (const { offset, line } of r.value.replay) res.write(`id: ${offset}\ndata: ${line}\n\n`);
    for (const frame of pending) res.write(frame);
    if (ended) {
      res.end();
      cleanup();
      return;
    }
    ping = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, pingMs);
  };

  const post = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    // GET-only routes mirror their method gate here too, and an unknown
    // route 404s — both checked before reading the body so a misrouted POST
    // never buffers a payload it's going to reject regardless.
    if (path === "/chat/status" || path === "/chat/events")
      return json(res, 405, { error: "method not allowed" });
    if (
      path !== "/chat/prompt" &&
      path !== "/chat/abort" &&
      path !== "/chat/new" &&
      path !== "/chat/note" &&
      path !== "/chat/decide"
    )
      return json(res, 404, { error: "not found" });

    const body = await readBody(req, maxTextBytes + 4096);
    if (!body.ok) return json(res, 413, { error: "payload too large" });
    const obj = parseJsonObject(body.text);
    const key = obj?.key;
    if (!obj || typeof key !== "string" || key === "")
      return json(res, 400, { error: "bad request" });
    const fail = (e: ChatError): void => json(res, STATUS[e], { error: e });
    switch (path) {
      case "/chat/prompt": {
        const text = obj.text;
        if (typeof text !== "string") return json(res, 400, { error: "bad request" });
        if (Buffer.byteLength(text, "utf8") > maxTextBytes)
          return json(res, 413, { error: "text too large" });
        // Ruling R33: `prompt` resolves on ADMISSION and the turn runs on
        // `r.value.done` — deliberately NOT awaited here. Awaiting it holds
        // the response open for the whole turn, and the dashboard's fetch
        // (undici, 300 s headersTimeout) rejects with "fetch failed" on any
        // turn longer than five minutes while the daemon keeps streaming.
        const r = await manager.prompt(key, text, { source: "operator" });
        if (!r.ok) return fail(r.error);
        return json(res, r.value.mode === "rejected" ? 200 : 202, { mode: r.value.mode });
      }
      case "/chat/abort": {
        const r = await manager.abort(key);
        if (!r.ok) return fail(r.error);
        res.writeHead(r.value.aborted ? 202 : 204);
        res.end();
        return;
      }
      case "/chat/new": {
        const r = await manager.fresh(key);
        if (!r.ok) return fail(r.error);
        res.writeHead(202);
        res.end();
        return;
      }
      case "/chat/note": {
        const rec = draftRecord(obj.record);
        if (rec === null) return json(res, 400, { error: "bad request" });
        const r = await manager.note(key, rec);
        if (!r.ok) return fail(r.error);
        res.writeHead(202);
        res.end();
        return;
      }
      case "/chat/decide": {
        const { commandId, decision } = obj;
        if (
          typeof commandId !== "string" ||
          commandId === "" ||
          (decision !== "run" && decision !== "decline")
        )
          return json(res, 400, { error: "bad request" });
        const r = await manager.decide(key, commandId, decision);
        if (!r.ok) return fail(r.error);
        if (!r.value.settled) return json(res, 409, { error: "not_pending" });
        res.writeHead(202);
        res.end();
        return;
      }
      default:
        return json(res, 404, { error: "not found" });
    }
  };

  return {
    async handle(req, res) {
      if (!isLoopback(req) || req.headers.origin !== undefined || !isHostAllowed(req, allowedHost))
        return json(res, 403, { error: "forbidden" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (req.method === "GET") {
        if (path === "/chat/events") return sse(req, res, url);
        if (path === "/chat/status") {
          const key = url.searchParams.get("key");
          if (!key) return json(res, 400, { error: "missing key" });
          if (!manager.enabled()) return json(res, 503, { error: "chat_disabled" });
          const s = manager.status(key);
          return s ? json(res, 200, s) : json(res, 404, { error: "unknown_key" });
        }
        if (
          path === "/chat/prompt" ||
          path === "/chat/abort" ||
          path === "/chat/new" ||
          path === "/chat/note" ||
          path === "/chat/decide"
        )
          return json(res, 405, { error: "method not allowed" });
        return json(res, 404, { error: "not found" });
      }
      if (req.method === "POST") return post(req, res, path);
      return json(res, 405, { error: "method not allowed" });
    },
  };
}
