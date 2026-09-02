// ---------------------------------------------------------------------------
// Health / liveness HTTP server (M5-T2)
// ---------------------------------------------------------------------------
// Provides three endpoints for process observability:
//   GET /live   — pure liveness (process is up + responsive)
//   GET /ready  — readiness (can it serve work; probes deps)
//   GET /health — rich ops view (always 200; includes full metrics snapshot)
// Plus, when an injected handler is wired: /chat/* (spec 2026-09-01 §5) —
// dashboard chat's SSE stream + POST verbs, loopback-only.
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MetricsSnapshot } from "./metrics.js";
import type { GateStatus } from "./providerGate.js";
import type { ChatHealth } from "./chat/chatManager.js";
import type { ChatRoutes } from "./chat/chatRoutes.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HealthServerOpts {
  /** Default "127.0.0.1" — loopback only; set "0.0.0.0" to expose on all interfaces. */
  host?: string;
  /** Use 0 for an ephemeral port (tests). The resolved port is in the handle. */
  port: number;
  /** Source of metrics. Typically the process-wide `metrics` singleton. */
  metrics: { snapshot(): MetricsSnapshot };
  /**
   * Async dependency probe. Should return true when dependencies (e.g. the inference endpoint)
   * are reachable. Defaults to `async () => true`.
   *
   * A rejection is treated as "not ready" — it does NOT cause a 500.
   */
  readinessProbe?: () => Promise<boolean>;
  /**
   * Source of the provider-gate's latched/backoff state (typically
   * `ProviderGate#status`, bound by the daemon). Omit when no gate is wired.
   *
   * `/health` always includes `gate: gateStatus?.() ?? null`. `/ready` treats
   * a non-"ok" gate as an override: even a passing `readinessProbe` cannot
   * make the endpoint "ready" while auth/quota/misconfig is latched, since no
   * work can actually be served. A throw is contained the same way as
   * `readinessProbe` (see `safeGate`) — it must never 500 the server.
   */
  gateStatus?: () => GateStatus;
  /**
   * Source of today's spend + configured daily cap (Phase-3 Task 6), typically
   * bound by the daemon to `spend.todayUsd()` + the live `dailyBudgetUsd`.
   * `/health` always includes `spend: spendStatus?.() ?? null`. A throw is
   * contained the same way as `gateStatus` (see `safeSpend`) — it must never
   * 500 the server.
   */
  spendStatus?: () => SpendStatus;
  /**
   * Where to report a post-listen server error (an accept-time failure such as
   * EMFILE under fd exhaustion). Defaults to `console.error`. The error is
   * logged and swallowed so it can never crash the host process (#121).
   */
  logFn?: (msg: string) => void;
  /** /chat/* handler (spec 2026-09-01 §5). Absent → those paths are 404. It
   *  is consulted BEFORE the GET-only gate: the handler owns its methods. */
  chat?: ChatRoutes;
  /** `/health.chats` — the chat manager's health view; absent on an older daemon. */
  chatStatus?: () => ChatHealth;
}

/** Today's USD spend + the configured daily cap (Phase-3 Task 6). `dailyBudgetUsd`
 * is 0 when the operator has no cap configured — mirrors `Config.dailyBudgetUsd`
 * (types.ts), duplicated here rather than imported so this transport-layer
 * module stays free of a `Config` dependency. */
export interface SpendStatus {
  todayUsd: number;
  dailyBudgetUsd: number;
}

export interface HealthServerHandle {
  /** The actual bound port (useful when port:0 was passed). */
  port: number;
  /** Base URL, e.g. http://127.0.0.1:49152 */
  url: string;
  /** The underlying HTTP server. Exposed for observability/tests; runtime consumers use port/url/close. */
  server?: Server;
  /** Graceful close. Resolves when the server is fully closed. Idempotent. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function writeJson(res: ServerResponse, statusCode: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Bracket an IPv6 literal for use in a URL authority (`::1` → `[::1]`); pass
 * others through. Exported for src/tui/ghClient.ts's chat healthBase — the
 * daemon-side twin of statusCmd.ts's own private copy (not touched here). */
export function bracketHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function safeProbe(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}

/**
 * A throwing `gateStatus` callback must not 500 the server — same
 * containment discipline as `safeProbe` above. On throw (or when no callback
 * was supplied) we treat it as "no gate signal": `/health` reports `gate:
 * null` and `/ready` falls back to the probe-driven result, rather than
 * guessing at a state we failed to read.
 */
function safeGate(gateStatus: (() => GateStatus) | undefined): GateStatus | null {
  if (!gateStatus) return null;
  try {
    return gateStatus();
  } catch {
    return null;
  }
}

/** Same containment discipline as `safeGate` above, for `spendStatus`. */
function safeSpend(spendStatus: (() => SpendStatus) | undefined): SpendStatus | null {
  if (!spendStatus) return null;
  try {
    return spendStatus();
  } catch {
    return null;
  }
}

/** Same containment discipline as `safeGate` above, for `chatStatus`. */
function safeChats(fn: (() => ChatHealth) | undefined): ChatHealth | null {
  if (!fn) return null;
  try {
    return fn();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function startHealthServer(opts: HealthServerOpts): Promise<HealthServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const probe = opts.readinessProbe ?? (async () => true);
  const logFn = opts.logFn ?? ((msg: string) => console.error(msg));

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // /chat/* is dispatched to the injected handler BEFORE the GET-only
      // gate below: it owns its own methods, auth boundary, and body parsing
      // (spec 2026-09-01 §5).
      const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
      if (rawPath === "/chat" || rawPath.startsWith("/chat/")) {
        if (!opts.chat) {
          writeJson(res, 404, { error: "not found" });
          return;
        }
        await opts.chat.handle(req, res);
        return;
      }

      // Method gate — only GET is supported
      if (req.method !== "GET") {
        writeJson(res, 405, { error: "method not allowed" });
        return;
      }

      // Strip any query string so /health?cb=123 (cache-busters, probe args)
      // still routes correctly.
      const path = (req.url ?? "/").split("?")[0];

      if (path === "/live") {
        const snap = opts.metrics.snapshot();
        writeJson(res, 200, {
          status: "alive",
          pid: snap.pid,
          uptimeSeconds: snap.uptimeSeconds,
        });
        return;
      }

      if (path === "/ready") {
        const gate = safeGate(opts.gateStatus);
        if (gate !== null && gate.state !== "ok") {
          // A latched/backed-off gate means work cannot be served regardless
          // of whether the endpoint itself is reachable — the probe result is
          // not even consulted here.
          writeJson(res, 503, {
            status: "not_ready",
            reason: gate.reason ?? gate.state,
          });
          return;
        }
        const ready = await safeProbe(probe);
        if (ready) {
          writeJson(res, 200, { status: "ready" });
        } else {
          writeJson(res, 503, {
            status: "not_ready",
            reason: "dependency unreachable",
          });
        }
        return;
      }

      if (path === "/health") {
        const [snap, ready] = await Promise.all([
          Promise.resolve(opts.metrics.snapshot()),
          safeProbe(probe),
        ]);
        const gate = safeGate(opts.gateStatus);
        const spend = safeSpend(opts.spendStatus);
        const chats = safeChats(opts.chatStatus);
        writeJson(res, 200, { status: "ok", ready, metrics: snap, gate, spend, chats });
        return;
      }

      // Unknown path
      writeJson(res, 404, { error: "not found" });
    } catch {
      // Unexpected handler throw — respond 500 and swallow
      try {
        writeJson(res, 500, { error: "internal" });
      } catch {
        // res might already be sent; ignore
      }
    }
  });

  return new Promise<HealthServerHandle>((resolve, reject) => {
    // Reject the promise if listen fails (e.g. EADDRINUSE) before success
    server.once("error", reject);

    server.listen(opts.port, host, () => {
      // Swap the one-shot `reject` (which only guards listen-time failures like
      // EADDRINUSE) for a persistent handler. Once we're listening, a later
      // accept-time error (e.g. EMFILE under fd exhaustion) must be logged and
      // swallowed — with no 'error' listener it would surface as an
      // uncaughtException and kill the whole host process (#121).
      server.removeListener("error", reject);
      server.on("error", (err: Error) => {
        logFn(`health server error (continuing): ${err.message}`);
      });

      const addr = server.address() as AddressInfo;
      const boundPort = addr.port;
      const url = `http://${bracketHost(addr.address)}:${boundPort}`;

      let closed = false;

      const handle: HealthServerHandle = {
        port: boundPort,
        url,
        server,
        close(): Promise<void> {
          if (closed) return Promise.resolve();
          closed = true;
          return new Promise<void>((res) => {
            // Close keep-alive connections immediately (Node ≥18.2)
            if (typeof server.closeAllConnections === "function") {
              server.closeAllConnections();
            }
            server.close(() => res());
          });
        },
      };

      resolve(handle);
    });
  });
}
