import { describe, it, expect } from "vitest";
import { fetchHealthBody, buildDaemonDetail, type HealthBody } from "../src/tui/localSnapshot.js";
import type { Config } from "../src/types.js";
import type { MetricsSnapshot } from "../src/metrics.js";

function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    healthEnabled: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    model: { baseUrl: "http://127.0.0.1:9999/v1", apiKey: "k", modelsJson: null },
    ...overrides,
  } as unknown as Config;
}

function metrics(over: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    startedAt: "2026-07-09T00:00:00Z",
    uptimeSeconds: 7890,
    pid: 4242,
    pollCount: 3,
    lastPollAt: null,
    currentTicket: "t-1",
    currentTickets: ["t-1", "t-2"],
    tasksProcessed: 5,
    tasksSucceeded: 4,
    tasksFailed: 1,
    tasksByStatus: { completed: 4, failed: 1 },
    totalTokensIn: 1000,
    totalTokensOut: 2000,
    totalDurationMs: 0,
    lastTaskAt: null,
    lastTaskStatus: null,
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
    guardNudges: 2,
    guardKills: 1,
    currentProgress: {
      "t-1": {
        turns: 3,
        lastTool: "bash",
        outputTokens: 500,
        startedAt: "2026-07-09T00:00:01Z",
        updatedAt: "2026-07-09T00:05:00Z",
      },
    },
    pendingRestartFields: [],
    ...over,
  };
}

/** Fake fetch: records urls; /health → the given body; anything else → ok. */
function recordingFetch(urls: string[], body: HealthBody | null): typeof fetch {
  return (async (url: string) => {
    urls.push(url);
    if (url.endsWith("/health")) {
      if (body === null) throw new Error("ECONNREFUSED");
      return { ok: true, json: async () => body };
    }
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

describe("fetchHealthBody", () => {
  it("returns the parsed body on ok; null when health disabled; null on network error", async () => {
    const body: HealthBody = { status: "ok", ready: true, metrics: metrics() };
    const urls: string[] = [];
    expect(await fetchHealthBody(makeCfg(), { fetchFn: recordingFetch(urls, body) })).toEqual(body);
    expect(urls).toEqual(["http://127.0.0.1:8787/health"]);
    expect(
      await fetchHealthBody(makeCfg({ healthEnabled: false } as Partial<Config>), {
        fetchFn: recordingFetch([], body),
      }),
    ).toBeNull();
    expect(await fetchHealthBody(makeCfg(), { fetchFn: recordingFetch([], null) })).toBeNull();
  });
});

describe("buildDaemonDetail", () => {
  it("maps a live /health body → up detail (pid, uptime, guards, tokens, tickets, progress w/o updatedAt)", async () => {
    const body: HealthBody = { status: "ok", ready: true, metrics: metrics() };
    const d = await buildDaemonDetail(makeCfg(), body, { fetchFn: recordingFetch([], body) });
    expect(d).toMatchObject({
      up: true,
      pid: 4242,
      uptimeSeconds: 7890,
      endpointReachable: true,
      healthHost: "127.0.0.1",
      healthPort: 8787,
      guardNudges: 2,
      guardKills: 1,
      tokensIn: 1000,
      tokensOut: 2000,
      tasksByStatus: { completed: 4, failed: 1 },
      currentTickets: ["t-1", "t-2"],
      error: null,
    });
    expect(d.progress["t-1"]).toEqual({
      turns: 3,
      lastTool: "bash",
      outputTokens: 500,
      startedAt: "2026-07-09T00:00:01Z",
    });
  });

  it("healthBody null (daemon down) → up:false but endpointReachable is probed independently", async () => {
    const d = await buildDaemonDetail(makeCfg(), null, { fetchFn: recordingFetch([], null) });
    expect(d.up).toBe(false);
    expect(d.pid).toBeNull();
    // endpointReachable probes /models — recordingFetch(_, null) throws only on /health, /models is ok.
    expect(d.endpointReachable).toBe(true);
    expect(d.currentTickets).toEqual([]);
    expect(d.error).toBeNull();
  });
});
