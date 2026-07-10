// ---------------------------------------------------------------------------
// Health / liveness HTTP server (M5-T2)
// ---------------------------------------------------------------------------
// Provides three endpoints for process observability:
//   GET /live   — pure liveness (process is up + responsive)
//   GET /ready  — readiness (can it serve work; probes deps)
//   GET /health — rich ops view (always 200; includes full metrics snapshot)
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MetricsSnapshot } from "./metrics.js";

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
}

export interface HealthServerHandle {
  /** The actual bound port (useful when port:0 was passed). */
  port: number;
  /** Base URL, e.g. http://127.0.0.1:49152 */
  url: string;
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

/** Bracket an IPv6 literal for use in a URL authority (`::1` → `[::1]`); pass others through. */
function bracketHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function safeProbe(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function startHealthServer(opts: HealthServerOpts): Promise<HealthServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const probe = opts.readinessProbe ?? (async () => true);

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
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
        writeJson(res, 200, { status: "ok", ready, metrics: snap });
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
      // Remove the pre-listen error listener so normal runtime errors don't
      // cause an unhandled rejection later.
      server.removeListener("error", reject);

      const addr = server.address() as AddressInfo;
      const boundPort = addr.port;
      const url = `http://${bracketHost(addr.address)}:${boundPort}`;

      let closed = false;

      const handle: HealthServerHandle = {
        port: boundPort,
        url,
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
