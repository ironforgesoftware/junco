/**
 * /chat/* on the health server (spec 2026-09-01 §5): SSE out, POST in, and
 * the auth boundary — loopback-only regardless of healthHost, and any request
 * carrying an Origin header is refused (a browser always sends one
 * cross-origin; the TUI never does), which closes the localhost-CSRF door
 * without a token. Every response is JSON except the event stream.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatManager, ChatError } from "./chatManager.js";
import type { ChatDraftRecord } from "../agent/transcriptSchema.js";

export type ChatRoutesManager = Pick<
  ChatManager,
  "enabled" | "prompt" | "abort" | "fresh" | "note" | "subscribe" | "status"
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
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackRequest(req: IncomingMessage): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? "");
}

const STATUS: Record<ChatError, number> = {
  unknown_key: 404,
  no_checkout: 409,
  not_a_repo: 409,
  chat_disabled: 503,
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

export function makeChatRoutes(manager: ChatRoutesManager, deps: ChatRoutesDeps = {}): ChatRoutes {
  const isLoopback = deps.isLoopback ?? isLoopbackRequest;
  const pingMs = deps.pingMs ?? 15_000;
  const maxTextBytes = deps.maxTextBytes ?? 64 * 1024;

  const sse = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const key = url.searchParams.get("key");
    if (!key) return json(res, 400, { error: "missing key" });
    const sinceRaw = url.searchParams.get("since") ?? req.headers["last-event-id"];
    const since = Number.parseInt(typeof sinceRaw === "string" ? sinceRaw : "0", 10);
    const r = await manager.subscribe(key, Number.isFinite(since) && since > 0 ? since : 0, {
      onLine(line, offset) {
        const data = line.endsWith("\n") ? line.slice(0, -1) : line;
        res.write(offset === null ? `data: ${data}\n\n` : `id: ${offset}\ndata: ${data}\n\n`);
      },
      onEnd(reason) {
        res.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
        res.end();
      },
    });
    if (!r.ok) return json(res, STATUS[r.error], { error: r.error });
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
    const ping = setInterval(() => res.write(": ping\n\n"), pingMs);
    const cleanup = (): void => {
      clearInterval(ping);
      r.value.unsubscribe();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  };

  const post = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
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
        const rec = obj.record;
        if (
          !rec ||
          typeof rec !== "object" ||
          (rec as { type?: unknown }).type !== "junco_chat_draft"
        )
          return json(res, 400, { error: "bad request" });
        const r = await manager.note(key, rec as Omit<ChatDraftRecord, "ts">);
        if (!r.ok) return fail(r.error);
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
      if (!isLoopback(req) || req.headers.origin !== undefined)
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
          path === "/chat/note"
        )
          return json(res, 405, { error: "method not allowed" });
        return json(res, 404, { error: "not found" });
      }
      if (req.method === "POST") return post(req, res, path);
      return json(res, 405, { error: "method not allowed" });
    },
  };
}
