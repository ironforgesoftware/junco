/**
 * Tests for src/healthServer.ts — health/liveness HTTP server.
 * Written FIRST (TDD). Uses real ephemeral server + global fetch.
 */

import { describe, it, expect, afterEach } from "vitest";
import { startHealthServer } from "../src/healthServer.js";
import type { HealthServerHandle, SpendStatus } from "../src/healthServer.js";
import type { MetricsSnapshot } from "../src/metrics.js";
import type { GateStatus } from "../src/providerGate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGateStatus(overrides: Partial<GateStatus> = {}): GateStatus {
  return {
    state: "ok",
    reason: null,
    since: null,
    until: null,
    ...overrides,
  };
}

function makeSpendStatus(overrides: Partial<SpendStatus> = {}): SpendStatus {
  return {
    todayUsd: 1.5,
    dailyBudgetUsd: 5,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    startedAt: "2026-05-31T00:00:00.000Z",
    uptimeSeconds: 42,
    pid: 12345,
    pollCount: 7,
    lastPollAt: "2026-05-31T00:00:30.000Z",
    currentTicket: null,
    currentTickets: [],
    tasksProcessed: 5,
    tasksSucceeded: 4,
    tasksFailed: 1,
    tasksByStatus: { completed: 4, failed: 1 },
    totalTokensIn: 1000,
    totalTokensOut: 2000,
    totalDurationMs: 30000,
    totalCostUsd: 0,
    lastTaskAt: "2026-05-31T00:00:28.000Z",
    lastTaskStatus: "completed",
    bridgeSweeps: 0,
    lastBridgeSweepAt: null,
    ticketsBridged: 0,
    bridgeErrors: 0,
    outboxDepth: 0,
    outboxEnqueued: 0,
    outboxFlushed: 0,
    outboxDead: 0,
    lastFlushAt: null,
    requeues: 0,
    guardNudges: 0,
    guardKills: 0,
    gateTransitions: {},
    currentProgress: {},
    pendingRestartFields: [],
    ...overrides,
  };
}

function makeFakeMetrics(snap?: Partial<MetricsSnapshot>) {
  const snapshot = makeSnapshot(snap);
  return { snapshot: () => snapshot };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("healthServer", () => {
  let handle: HealthServerHandle | null = null;

  afterEach(async () => {
    if (handle !== null) {
      await handle.close();
      handle = null;
    }
  });

  // -------------------------------------------------------------------------
  // handle metadata
  // -------------------------------------------------------------------------

  it("handle.port is the real ephemeral port (> 0) and url contains it", async () => {
    handle = await startHealthServer({
      port: 0,
      metrics: makeFakeMetrics(),
    });

    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toContain(String(handle.port));
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("brackets an IPv6 bind address in handle.url and serves over it (#119)", async () => {
    handle = await startHealthServer({
      port: 0,
      host: "::1",
      metrics: makeFakeMetrics(),
    });
    // Bare `http://::1:<port>` is a malformed authority that fetch/new URL reject.
    expect(handle.url).toBe(`http://[::1]:${handle.port}`);
    const resp = await fetch(`${handle.url}/live`);
    expect(resp.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // GET /live
  // -------------------------------------------------------------------------

  describe("GET /live", () => {
    it("returns 200 with status alive, pid, uptimeSeconds from snapshot", async () => {
      const snap = makeSnapshot({ pid: 99999, uptimeSeconds: 123 });
      handle = await startHealthServer({
        port: 0,
        metrics: { snapshot: () => snap },
      });

      const resp = await fetch(`${handle.url}/live`);
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toMatch(/application\/json/);

      const body = (await resp.json()) as { status: string; pid: number; uptimeSeconds: number };
      expect(body.status).toBe("alive");
      expect(body.pid).toBe(99999);
      expect(body.uptimeSeconds).toBe(123);
    });

    it("returns 200 regardless of readiness probe result", async () => {
      handle = await startHealthServer({
        port: 0,
        metrics: makeFakeMetrics(),
        readinessProbe: async () => false,
      });

      const resp = await fetch(`${handle.url}/live`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { status: string };
      expect(body.status).toBe("alive");
    });

    it("routes correctly when a query string is present (/live?cb=1)", async () => {
      handle = await startHealthServer({ port: 0, metrics: makeFakeMetrics() });
      const resp = await fetch(`${handle.url}/live?cb=123`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { status: string };
      expect(body.status).toBe("alive");
    });
  });

  // -------------------------------------------------------------------------
  // GET /ready
  // -------------------------------------------------------------------------

  describe("GET /ready", () => {
    it("returns 200 {status: ready} when probe returns true", async () => {
      handle = await startHealthServer({
        port: 0,
        metrics: makeFakeMetrics(),
        readinessProbe: async () => true,
      });

      const resp = await fetch(`${handle.url}/ready`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { status: string };
      expect(body.status).toBe("ready");
    });

    it("returns 503 {status: not_ready, reason: ...} when probe returns false", async () => {
      handle = await startHealthServer({
        port: 0,
        metrics: makeFakeMetrics(),
        readinessProbe: async () => false,
      });

      const resp = await fetch(`${handle.url}/ready`);
      expect(resp.status).toBe(503);
      const body = (await resp.json()) as { status: string; reason: string };
      expect(body.status).toBe("not_ready");
      expect(body.reason).toBeTruthy();
    });

    it("returns 503 when probe rejects (treat as not ready, not 500)", async () => {
      handle = await startHealthServer({
        port: 0,
        metrics: makeFakeMetrics(),
        readinessProbe: async () => {
          throw new Error("probe exploded");
        },
      });

      const resp = await fetch(`${handle.url}/ready`);
      expect(resp.status).toBe(503);
      const body = (await resp.json()) as { status: string };
      expect(body.status).toBe("not_ready");
    });

    it("defaults to ready (probe = true) when no readinessProbe provided", async () => {
      handle = await startHealthServer({
        port: 0,
        metrics: makeFakeMetrics(),
        // no readinessProbe
      });

      const resp = await fetch(`${handle.url}/ready`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { status: string };
      expect(body.status).toBe("ready");
    });
  });

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------

  describe("GET /health", () => {
    it("returns 200 with status ok, ready bool, and full metrics snapshot", async () => {
      const snap = makeSnapshot({
        tasksProcessed: 5,
        tasksSucceeded: 4,
        tasksFailed: 1,
        totalTokensIn: 1000,
        totalTokensOut: 2000,
        requeues: 3,
        guardNudges: 2,
        guardKills: 1,
      });

      handle = await startHealthServer({
        port: 0,
        metrics: { snapshot: () => snap },
        readinessProbe: async () => true,
      });

      const resp = await fetch(`${handle.url}/health`);
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toMatch(/application\/json/);

      const body = (await resp.json()) as {
        status: string;
        ready: boolean;
        metrics: MetricsSnapshot;
      };
      expect(body.status).toBe("ok");
      expect(body.ready).toBe(true);
      expect(body.metrics.tasksProcessed).toBe(5);
      expect(body.metrics.tasksSucceeded).toBe(4);
      expect(body.metrics.tasksFailed).toBe(1);
      expect(body.metrics.totalTokensIn).toBe(1000);
      expect(body.metrics.totalTokensOut).toBe(2000);
      // #37: requeue + guard counters surface through the snapshot passthrough.
      expect(body.metrics.requeues).toBe(3);
      expect(body.metrics.guardNudges).toBe(2);
      expect(body.metrics.guardKills).toBe(1);
    });

    it("returns 200 even when not ready (ready=false, status still ok)", async () => {
      handle = await startHealthServer({
        port: 0,
        metrics: makeFakeMetrics(),
        readinessProbe: async () => false,
      });

      const resp = await fetch(`${handle.url}/health`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { status: string; ready: boolean };
      expect(body.status).toBe("ok");
      expect(body.ready).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Provider-gate status (/health, /ready)
  // -------------------------------------------------------------------------

  describe("gate status", () => {
    it("gate ok + probe true → /health.gate.state is 'ok' and /ready is 200", async () => {
      const gate = makeGateStatus({ state: "ok" });
      handle = await startHealthServer({
        port: 0,
        metrics: makeFakeMetrics(),
        readinessProbe: async () => true,
        gateStatus: () => gate,
      });

      const healthResp = await fetch(`${handle.url}/health`);
      expect(healthResp.status).toBe(200);
      const healthBody = (await healthResp.json()) as { gate: GateStatus };
      expect(healthBody.gate.state).toBe("ok");

      const readyResp = await fetch(`${handle.url}/ready`);
      expect(readyResp.status).toBe(200);
      const readyBody = (await readyResp.json()) as { status: string };
      expect(readyBody.status).toBe("ready");
    });

    it("gate auth_error → /ready is 503 with the gate's reason even when the probe passes", async () => {
      const gate = makeGateStatus({
        state: "auth_error",
        reason: "401 unauthorized",
        since: "2026-07-01T00:00:00.000Z",
      });
      handle = await startHealthServer({
        port: 0,
        metrics: makeFakeMetrics(),
        readinessProbe: async () => true, // endpoint pings fine — the latch must still win
        gateStatus: () => gate,
      });

      const readyResp = await fetch(`${handle.url}/ready`);
      expect(readyResp.status).toBe(503);
      const readyBody = (await readyResp.json()) as { status: string; reason: string };
      expect(readyBody.status).toBe("not_ready");
      expect(readyBody.reason).toBe("401 unauthorized");

      const healthResp = await fetch(`${handle.url}/health`);
      expect(healthResp.status).toBe(200);
      const healthBody = (await healthResp.json()) as { gate: GateStatus };
      expect(healthBody.gate.state).toBe("auth_error");
      expect(healthBody.gate.reason).toBe("401 unauthorized");
    });

    it("gate non-ok with a null reason falls back to the state name in /ready's reason", async () => {
      const gate = makeGateStatus({ state: "misconfig", reason: null });
      handle = await startHealthServer({
        port: 0,
        metrics: makeFakeMetrics(),
        readinessProbe: async () => true,
        gateStatus: () => gate,
      });

      const readyResp = await fetch(`${handle.url}/ready`);
      expect(readyResp.status).toBe(503);
      const readyBody = (await readyResp.json()) as { reason: string };
      expect(readyBody.reason).toBe("misconfig");
    });

    it("no gateStatus option → /health.gate is null and /ready behavior is unchanged", async () => {
      handle = await startHealthServer({
        port: 0,
        metrics: makeFakeMetrics(),
        readinessProbe: async () => true,
      });

      const healthResp = await fetch(`${handle.url}/health`);
      const healthBody = (await healthResp.json()) as { gate: GateStatus | null };
      expect(healthBody.gate).toBeNull();

      const readyResp = await fetch(`${handle.url}/ready`);
      expect(readyResp.status).toBe(200);
      const readyBody = (await readyResp.json()) as { status: string };
      expect(readyBody.status).toBe("ready");
    });

    it("a throwing gateStatus does not 500 — /ready and /health fall back to probe-driven behavior", async () => {
      handle = await startHealthServer({
        port: 0,
        metrics: makeFakeMetrics(),
        readinessProbe: async () => true,
        gateStatus: () => {
          throw new Error("gate exploded");
        },
      });

      const readyResp = await fetch(`${handle.url}/ready`);
      expect(readyResp.status).toBe(200);
      const readyBody = (await readyResp.json()) as { status: string };
      expect(readyBody.status).toBe("ready");

      const healthResp = await fetch(`${handle.url}/health`);
      expect(healthResp.status).toBe(200);
      const healthBody = (await healthResp.json()) as { gate: GateStatus | null };
      expect(healthBody.gate).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Spend status (/health) — Phase-3 Task 6
  // -------------------------------------------------------------------------

  describe("spend status", () => {
    it("spendStatus present → /health.spend has todayUsd + dailyBudgetUsd", async () => {
      const spend = makeSpendStatus({ todayUsd: 2.34, dailyBudgetUsd: 10 });
      handle = await startHealthServer({
        port: 0,
        metrics: makeFakeMetrics(),
        spendStatus: () => spend,
      });

      const resp = await fetch(`${handle.url}/health`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { spend: SpendStatus };
      expect(body.spend).toEqual({ todayUsd: 2.34, dailyBudgetUsd: 10 });
    });

    it("no spendStatus option → /health.spend is null", async () => {
      handle = await startHealthServer({
        port: 0,
        metrics: makeFakeMetrics(),
      });

      const resp = await fetch(`${handle.url}/health`);
      const body = (await resp.json()) as { spend: SpendStatus | null };
      expect(body.spend).toBeNull();
    });

    it("a throwing spendStatus does not 500 — /health.spend falls back to null", async () => {
      handle = await startHealthServer({
        port: 0,
        metrics: makeFakeMetrics(),
        spendStatus: () => {
          throw new Error("spend exploded");
        },
      });

      const resp = await fetch(`${handle.url}/health`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { spend: SpendStatus | null };
      expect(body.spend).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Chat status (/health) — dashboard chat (spec 2026-09-01 §5)
  // -------------------------------------------------------------------------

  it("/health carries `chats` from chatStatus, and /chat/* is 404 without a chat handler", async () => {
    handle = await startHealthServer({
      port: 0,
      metrics: makeFakeMetrics(),
      chatStatus: () => ({
        enabled: true,
        sessions: [],
        turns: 0,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    const body = (await (await fetch(`${handle.url}/health`)).json()) as { chats?: unknown };
    expect(body.chats).toEqual({
      enabled: true,
      sessions: [],
      turns: 0,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
    expect((await fetch(`${handle.url}/chat/status?key=k`)).status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Unknown path / wrong method
  // -------------------------------------------------------------------------

  it("GET /unknown-path returns 404", async () => {
    handle = await startHealthServer({
      port: 0,
      metrics: makeFakeMetrics(),
    });

    const resp = await fetch(`${handle.url}/nope`);
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("POST /health returns 405", async () => {
    handle = await startHealthServer({
      port: 0,
      metrics: makeFakeMetrics(),
    });

    const resp = await fetch(`${handle.url}/health`, { method: "POST" });
    expect(resp.status).toBe(405);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // close() idempotent
  // -------------------------------------------------------------------------

  it("keeps a persistent error handler so a post-listen error does not crash (#121)", async () => {
    const logs: string[] = [];
    handle = await startHealthServer({
      port: 0,
      metrics: makeFakeMetrics(),
      logFn: (m) => logs.push(m),
    });

    const server = handle.server!;
    // Simulate an accept-time failure (e.g. EMFILE under fd exhaustion). With no
    // 'error' listener, emit() throws — from Node's socket path that is an
    // uncaughtException that kills the daemon. A persistent handler swallows it.
    expect(() => server.emit("error", new Error("EMFILE"))).not.toThrow();
    expect(logs.some((l) => l.includes("EMFILE"))).toBe(true);

    // The server keeps serving after the error.
    const resp = await fetch(`${handle.url}/live`);
    expect(resp.status).toBe(200);
  });

  it("an unexpected handler throw answers 500 AND is logged with the path", async () => {
    const logged: string[] = [];
    handle = await startHealthServer({
      port: 0,
      metrics: {
        snapshot: () => {
          throw new Error("metrics exploded");
        },
      },
      logFn: (m) => logged.push(m),
    });
    const resp = await fetch(`${handle.url}/health`);
    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: "internal" });
    // A silent 500 is unactionable: the operator sees a dead endpoint and the
    // daemon says nothing about why.
    expect(logged.some((m) => m.includes("/health") && m.includes("metrics exploded"))).toBe(true);
  });

  it("close() is idempotent — second call resolves without throwing", async () => {
    handle = await startHealthServer({
      port: 0,
      metrics: makeFakeMetrics(),
    });

    await handle.close();
    // Second close should not throw
    await expect(handle.close()).resolves.toBeUndefined();

    // After close, a fetch should fail (server is gone)
    const url = handle.url;
    handle = null; // prevent afterEach from double-closing

    await expect(fetch(`${url}/live`)).rejects.toThrow();
  });
});
