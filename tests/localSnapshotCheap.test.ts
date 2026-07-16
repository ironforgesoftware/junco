import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeLocalCheapFn, type HealthBody } from "../src/tui/localSnapshot.js";
import { OUTBOX_SUBDIR } from "../src/dataTree.js";
import type { Config } from "../src/types.js";

function makeCfg(root: string): Config {
  return {
    dataDir: join(root, "state"),
    queueRoot: join(root, "vault", "q"),
    worktreeRoot: join(root, "wt"),
    defaultTimeoutMinutes: 30,
    maxConcurrent: 1,
    healthEnabled: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    gitBin: "git",
    ghBin: "gh",
    // id must be "local/…" — shouldProbeEndpoint's catalogEligible check reads
    // it unconditionally now, and this fixture is a local test server (must
    // always probe), not a hosted catalog model.
    model: {
      id: "local/test-model",
      baseUrl: "http://127.0.0.1:9999/v1",
      apiKey: "k",
      modelsJson: null,
    },
    github: { enabled: true, repos: [], externalReposRoot: join(root, "external") },
  } as unknown as Config;
}

const HEALTH: HealthBody = {
  status: "ok",
  ready: true,
  metrics: {
    pid: 99,
    uptimeSeconds: 10,
    currentTickets: ["run-1"],
    currentProgress: {},
    tasksByStatus: {},
    totalTokensIn: 0,
    totalTokensOut: 0,
    guardNudges: 0,
    guardKills: 0,
  } as unknown as HealthBody["metrics"],
};

function recordingFetch(urls: string[]): typeof fetch {
  return (async (url: string) => {
    urls.push(url);
    if (url.endsWith("/health")) return { ok: true, json: async () => HEALTH };
    return { ok: true, json: async () => ({}) }; // /models probe
  }) as unknown as typeof fetch;
}

describe("makeLocalCheapFn", () => {
  it("issues exactly ONE /health request (queue + daemon share the pre-fetched body)", async () => {
    const cfg = makeCfg(mkdtempSync(join(tmpdir(), "junco-cheap-")));
    const urls: string[] = [];
    const cheap = await makeLocalCheapFn(cfg, { fetchFn: recordingFetch(urls) })();
    expect(urls.filter((u) => u.endsWith("/health"))).toHaveLength(1);
    expect(cheap.queue.daemonUp).toBe(true);
    expect(cheap.queue.running.map((r) => r.id)).toEqual(["run-1"]);
    expect(cheap.daemon.up).toBe(true);
    expect(cheap.daemon.pid).toBe(99);
  });

  it("counts (done/failed) are computed ONLY when section === 'queue'", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-cheap2-"));
    const cfg = makeCfg(root);
    const done = join(cfg.queueRoot, "done");
    const failed = join(cfg.queueRoot, "failed");
    mkdirSync(done, { recursive: true });
    mkdirSync(failed, { recursive: true });
    writeFileSync(join(done, "a.md"), "x");
    writeFileSync(join(failed, "b.md"), "x");
    writeFileSync(join(failed, "c.md"), "x");
    const fn = makeLocalCheapFn(cfg, { fetchFn: recordingFetch([]) });
    expect((await fn({ section: "outbox" })).counts).toBeNull();
    expect((await fn({ section: "queue" })).counts).toEqual({ done: 1, failed: 2 });
  });

  it("outbox: live + dead split via listOpsFrom", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-cheap3-"));
    const cfg = makeCfg(root);
    const obx = join(cfg.dataDir, OUTBOX_SUBDIR);
    const dead = join(obx, "dead");
    mkdirSync(dead, { recursive: true });
    writeFileSync(
      join(obx, "1-0-a-labels.json"),
      JSON.stringify({
        origin: "prflow",
        attempts: 0,
        lastError: null,
        op: { kind: "labels", nwo: "a/b", issue: 1, add: [], remove: [] },
      }),
    );
    writeFileSync(
      join(dead, "2-0-b-labels.json"),
      JSON.stringify({
        origin: "prflow",
        attempts: 3,
        lastError: "boom",
        op: { kind: "labels", nwo: "a/b", issue: 2, add: [], remove: [] },
      }),
    );
    const cheap = await makeLocalCheapFn(cfg, { fetchFn: recordingFetch([]) })();
    expect(cheap.outbox.depth).toBe(1);
    expect(cheap.outbox.dead).toBe(1);
    expect(cheap.outbox.ops[0].op.kind).toBe("labels");
    expect(cheap.outbox.deadOps[0].lastError).toBe("boom");
  });

  it("caches the endpoint probe per factory: two quick ticks → ONE /models probe, two /health", async () => {
    const cfg = makeCfg(mkdtempSync(join(tmpdir(), "junco-cheap5-")));
    const urls: string[] = [];
    const fn = makeLocalCheapFn(cfg, { fetchFn: recordingFetch(urls) });
    await fn();
    await fn();
    // /health is fetched every tick; the /models probe is TTL-cached inside
    // the factory closure (makeCachedProbe), so the second tick reuses it.
    expect(urls.filter((u) => u.endsWith("/health"))).toHaveLength(2);
    expect(urls.filter((u) => u.endsWith("/models"))).toHaveLength(1);
  });

  it("never-throws: a throwing fetchFn yields a renderable snapshot (daemon down, no throw)", async () => {
    const cfg = makeCfg(mkdtempSync(join(tmpdir(), "junco-cheap4-")));
    const boom = (async () => {
      throw new Error("net down");
    }) as unknown as typeof fetch;
    const cheap = await makeLocalCheapFn(cfg, { fetchFn: boom })();
    expect(cheap.daemon.up).toBe(false);
    expect(cheap.queue.daemonUp).toBe(false);
    expect(cheap.error).toBeNull();
  });
});
