/**
 * Tests for src/healthServer.ts — health/liveness HTTP server.
 * Written FIRST (TDD). Uses real ephemeral server + global fetch.
 */

import { describe, it, expect, afterEach } from "vitest";
import { startHealthServer } from "../src/healthServer.js";
import type { HealthServerHandle } from "../src/healthServer.js";
import type { MetricsSnapshot } from "../src/metrics.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    currentProgress: {},
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
