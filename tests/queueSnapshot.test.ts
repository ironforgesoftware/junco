import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeQueueSnapshotFn, stripStamp } from "../src/tui/queueSnapshot.js";
import { enqueueOp } from "../src/githubOutbox.js";
import type { HealthBody } from "../src/tui/healthBody.js";
import type { Config } from "../src/types.js";

/** Minimal config over a sandboxed queue root (same cast style as dashboardCmd.test.ts).
 * `dataDir` is always populated so the stats layer (history ledger + outbox dirs,
 * Task 6/7) resolves a real path — an unset dataDir would make queueStats' path
 * joins throw and sink the whole snapshot. */
function makeQueueCfg(root: string, overrides: Partial<Config> = {}): Config {
  return {
    queueRoot: join(root, "q"),
    dataDir: join(root, "state"),
    defaultTimeoutMinutes: 30,
    maxConcurrent: 1,
    healthEnabled: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    ...overrides,
  } as unknown as Config;
}

function setupDirs(): {
  root: string;
  inbox: string;
  processing: string;
  done: string;
  failed: string;
} {
  const root = mkdtempSync(join(tmpdir(), "junco-qsnap-"));
  const dirs = {
    root,
    inbox: join(root, "q", "inbox"),
    processing: join(root, "q", "processing"),
    done: join(root, "q", "done"),
    failed: join(root, "q", "failed"),
  };
  for (const d of [dirs.inbox, dirs.processing, dirs.done, dirs.failed]) {
    mkdirSync(d, { recursive: true });
  }
  return dirs;
}

function writeTicket(dir: string, name: string, fm: string, body = "do the thing"): void {
  writeFileSync(join(dir, name), `---\n${fm}\n---\n\n${body}\n`);
}

/** /health fetch fake: resolve with the given metrics, or reject. */
function healthFetch(metrics: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    json: async () => ({ ready: true, metrics }),
  })) as unknown as typeof fetch;
}
const downFetch: typeof fetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

describe("stripStamp", () => {
  it("strips the claim prefix and leaves clean names alone", () => {
    expect(stripStamp("2026-07-07T1005Z__gh-a-b-46-plan")).toBe("gh-a-b-46-plan");
    expect(stripStamp("gh-a-b-46-plan")).toBe("gh-a-b-46-plan");
    expect(stripStamp("my__odd__name")).toBe("my__odd__name"); // no stamp → untouched
  });
});

describe("waiting list", () => {
  it("orders by priority rank desc, stable (filename order) within rank", async () => {
    const d = setupDirs();
    writeTicket(d.inbox, "a-normal.md", "id: a-normal");
    writeTicket(d.inbox, "b-high.md", "id: b-high\npriority: high");
    writeTicket(d.inbox, "c-normal.md", "id: c-normal");
    writeTicket(d.inbox, "d-low.md", "id: d-low\npriority: low");
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), { fetchFn: downFetch })();
    expect(snap.waiting.map((w) => w.id)).toEqual(["b-high", "a-normal", "c-normal", "d-low"]);
  });

  it("marks future not_before as deferred (keeps position); past/garbage are eligible", async () => {
    const d = setupDirs();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();
    writeTicket(d.inbox, "a.md", `id: a\nnot_before: "${future}"\nretry_count: 2`);
    writeTicket(d.inbox, "b.md", `id: b\nnot_before: "${past}"`);
    writeTicket(d.inbox, "c.md", 'id: c\nnot_before: "not-a-date"');
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), { fetchFn: downFetch })();
    expect(snap.waiting.map((w) => [w.id, w.deferred])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
    expect(snap.waiting[0].notBefore).toBe(future);
    expect(snap.waiting[0].retryCount).toBe(2);
    expect(snap.waiting[1].notBefore).toBeNull();
  });

  it("derives kind: github kind wins; manual repo → pr; manual bare → ask; assess → assess", async () => {
    const d = setupDirs();
    writeTicket(
      d.inbox,
      "a-plan.md",
      "id: a-plan\ngithub:\n  nwo: acme/api\n  issue: 46\n  kind: plan",
    );
    writeTicket(d.inbox, "b-repo.md", "id: b-repo\nrepo: ~/src/thing");
    writeTicket(d.inbox, "c-bare.md", "id: c-bare");
    writeTicket(d.inbox, "d-assess.md", "id: d-assess\nrepo: ~/src/thing\nassess: {}");
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), { fetchFn: downFetch })();
    expect(snap.waiting.map((w) => [w.id, w.kind])).toEqual([
      ["a-plan", "plan"],
      ["b-repo", "pr"],
      ["c-bare", "ask"],
      ["d-assess", "assess"],
    ]);
    expect(snap.waiting[0].github).toEqual({
      nwo: "acme/api",
      issue: 46,
      kind: "plan",
      external: false,
    });
    expect(snap.waiting[1].github).toBeNull();
  });

  it("skips unreadable inbox files instead of failing the snapshot", async () => {
    const d = setupDirs();
    writeTicket(d.inbox, "good.md", "id: good");
    writeTicket(d.inbox, "gone.md", "id: gone");
    const readFileFn = (p: string): string => {
      if (p.endsWith("gone.md")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return readFileSync(p, "utf8");
    };
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), {
      fetchFn: downFetch,
      readFileFn,
    })();
    expect(snap.waiting.map((w) => w.id)).toEqual(["good"]);
    expect(snap.error).toBeNull();
  });
});

describe("running", () => {
  it("daemon up: currentTickets enriched from currentProgress and processing/ github map", async () => {
    const d = setupDirs();
    writeTicket(
      d.processing,
      "2026-07-07T1005Z__gh-acme-api-46.md",
      "id: gh-acme-api-46\nrepo: /c/api\ngithub:\n  nwo: acme/api\n  issue: 46\n  kind: pr",
    );
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), {
      fetchFn: healthFetch({
        currentTickets: ["gh-acme-api-46"],
        currentProgress: {
          "gh-acme-api-46": {
            turns: 14,
            lastTool: "bash",
            outputTokens: 12345,
            startedAt: "2026-07-07T10:00:00.000Z",
            updatedAt: "2026-07-07T10:04:00.000Z",
          },
        },
      }),
    })();
    expect(snap.daemonUp).toBe(true);
    expect(snap.running).toEqual([
      {
        id: "gh-acme-api-46",
        github: { nwo: "acme/api", issue: 46, kind: "pr", external: false },
        turns: 14,
        lastTool: "bash",
        outputTokens: 12345,
        startedAt: "2026-07-07T10:00:00.000Z",
        updatedAt: "2026-07-07T10:04:00.000Z",
        stale: false,
        repoPath: "/c/api",
      },
    ]);
  });

  it("daemon up but no progress entry yet: nulls, not a crash", async () => {
    const d = setupDirs();
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), {
      fetchFn: healthFetch({ currentTickets: ["mystery"], currentProgress: {} }),
    })();
    expect(snap.running).toEqual([
      {
        id: "mystery",
        github: null,
        turns: null,
        lastTool: null,
        outputTokens: null,
        startedAt: null,
        updatedAt: null,
        stale: false,
        repoPath: null,
      },
    ]);
  });

  it("daemon down: falls back to processing/ files, stamp stripped, stale: true", async () => {
    const d = setupDirs();
    writeTicket(
      d.processing,
      "2026-07-07T1005Z__gh-acme-api-9-plan.md",
      "github:\n  nwo: acme/api\n  issue: 9\n  kind: plan",
    );
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), { fetchFn: downFetch })();
    expect(snap.daemonUp).toBe(false);
    expect(snap.running).toEqual([
      {
        id: "gh-acme-api-9-plan",
        github: { nwo: "acme/api", issue: 9, kind: "plan", external: false },
        turns: null,
        lastTool: null,
        outputTokens: null,
        startedAt: null,
        updatedAt: null,
        stale: true,
        repoPath: null,
      },
    ]);
  });

  it("healthEnabled=false never fetches and uses the fallback", async () => {
    const d = setupDirs();
    let fetched = 0;
    const spyFetch: typeof fetch = (async () => {
      fetched++;
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const snap = await makeQueueSnapshotFn(
      makeQueueCfg(d.root, { healthEnabled: false } as Partial<Config>),
      { fetchFn: spyFetch },
    )();
    expect(fetched).toBe(0);
    expect(snap.daemonUp).toBe(false);
  });
});

describe("taskTimeoutSeconds", () => {
  it("derives from cfg.defaultTimeoutMinutes (30m → 1800s)", async () => {
    const d = setupDirs();
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), { fetchFn: downFetch })();
    expect(snap.taskTimeoutSeconds).toBe(1800);
  });

  it("cfg.defaultTimeoutMinutes <= 0 → null (unknown budget)", async () => {
    const d = setupDirs();
    const snap = await makeQueueSnapshotFn(
      makeQueueCfg(d.root, { defaultTimeoutMinutes: 0 } as Partial<Config>),
      { fetchFn: downFetch },
    )();
    expect(snap.taskTimeoutSeconds).toBeNull();
  });

  it("survives the never-throws error path (still carried on the base object)", async () => {
    const d = setupDirs();
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), {
      fetchFn: downFetch,
      nowFn: () => {
        throw new Error("clock boom");
      },
    })();
    expect(snap.error).toBe("clock boom");
    expect(snap.taskTimeoutSeconds).toBe(1800);
  });
});

describe("recent", () => {
  it("merges done+failed newest-first by mtime, caps at 5, status from dir", async () => {
    const d = setupDirs();
    for (let i = 1; i <= 4; i++) {
      writeTicket(d.done, `2026-07-07T100${i}Z__done-${i}.md`, `id: done-${i}`);
    }
    for (let i = 1; i <= 3; i++) {
      writeTicket(d.failed, `2026-07-07T100${i}Z__fail-${i}.md`, `id: fail-${i}`);
    }
    // Deterministic mtimes via statFn fake: encode order from the filename digit.
    const statFn = (p: string): { mtimeMs: number } => {
      const m = /(\d)\.md$/.exec(p);
      const base = p.includes("fail-") ? 0.5 : 0; // interleave: done-1, fail-1, done-2, ...
      return { mtimeMs: Number(m![1]) * 1000 + base * 1000 };
    };
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), {
      fetchFn: downFetch,
      statFn,
    })();
    expect(snap.recent).toHaveLength(5);
    expect(snap.recent[0].id).toBe("done-4"); // highest mtime
    expect(snap.recent.map((r) => r.status)).toContain("failed");
    expect(new Date(snap.recent[0].finishedAt).getTime()).toBe(4000);
  });
});

describe("repoPath", () => {
  it("carries the ticket's repo path on waiting/running/recent rows", async () => {
    const d = setupDirs();
    writeTicket(d.inbox, "with-repo.md", "id: with-repo\nrepo: /tmp/proj-a");
    writeTicket(d.inbox, "no-repo.md", "id: no-repo");
    // Daemon down → running falls back to processing/ (repoPath from the file).
    writeTicket(d.processing, "2026-07-07T1005Z__proc-b.md", "id: proc-b\nrepo: /tmp/proj-b");
    writeTicket(d.done, "2026-07-07T1006Z__done-c.md", "id: done-c\nrepo: /tmp/proj-c");
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), { fetchFn: downFetch })();
    expect(snap.waiting.find((w) => w.id === "with-repo")?.repoPath).toBe("/tmp/proj-a");
    expect(snap.waiting.find((w) => w.id === "no-repo")?.repoPath).toBeNull();
    expect(snap.running[0]?.repoPath).toBe("/tmp/proj-b");
    expect(snap.recent[0]?.repoPath).toBe("/tmp/proj-c");
  });

  it("daemon up: running repoPath comes from the processing/ ticket map", async () => {
    const d = setupDirs();
    writeTicket(d.processing, "2026-07-07T1005Z__run-x.md", "id: run-x\nrepo: /tmp/proj-x");
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), {
      fetchFn: healthFetch({ currentTickets: ["run-x", "mystery"], currentProgress: {} }),
    })();
    expect(snap.running.find((r) => r.id === "run-x")?.repoPath).toBe("/tmp/proj-x");
    expect(snap.running.find((r) => r.id === "mystery")?.repoPath).toBeNull();
  });
});

describe("outboxDepth", () => {
  it("counts queued outbox ops for the config's state dir; empty is 0", async () => {
    const d = setupDirs();
    const stateDir = join(d.root, "state");
    const cfg = makeQueueCfg(d.root, { dataDir: stateDir } as Partial<Config>);

    const empty = await makeQueueSnapshotFn(cfg, { fetchFn: downFetch })();
    expect(empty.outboxDepth).toBe(0);

    enqueueOp(cfg, "dashboard", {
      kind: "labels",
      nwo: "a/b",
      issue: 7,
      add: ["junco"],
      remove: [],
    });
    enqueueOp(cfg, "dashboard", {
      kind: "labels",
      nwo: "a/b",
      issue: 8,
      add: ["junco"],
      remove: [],
    });
    const snap = await makeQueueSnapshotFn(cfg, { fetchFn: downFetch })();
    expect(snap.outboxDepth).toBe(2);
  });
});

describe("never-throws contract", () => {
  it("an unexpected failure returns error set, empty lists", async () => {
    const d = setupDirs();
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), {
      fetchFn: downFetch,
      nowFn: () => {
        throw new Error("clock boom");
      },
    })();
    expect(snap.error).toBe("clock boom");
    expect(snap.waiting).toEqual([]);
    expect(snap.running).toEqual([]);
    expect(snap.stats).toBeNull(); // error-path base object never carries stats
  });

  it("missing queue dirs (fresh install) → empty snapshot, no error", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-qsnap-empty-"));
    const snap = await makeQueueSnapshotFn(makeQueueCfg(root), { fetchFn: downFetch })();
    expect(snap).toMatchObject({ waiting: [], running: [], recent: [], error: null });
  });
});

describe("waiting queuedAt", () => {
  it("carries the inbox file mtime (ISO); a stat failure → null", async () => {
    const d = setupDirs();
    writeTicket(d.inbox, "a-high.md", "id: a-high\npriority: high");
    writeTicket(d.inbox, "b-normal.md", "id: b-normal");
    const statFn = (p: string): { mtimeMs: number } => {
      if (p.endsWith("a-high.md")) return { mtimeMs: 1_700_000_000_000 };
      if (p.endsWith("b-normal.md")) throw new Error("ENOENT");
      return { mtimeMs: 0 }; // history/queue-dir stats — swallowed downstream
    };
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), {
      fetchFn: downFetch,
      statFn,
    })();
    const a = snap.waiting.find((w) => w.id === "a-high")!;
    const b = snap.waiting.find((w) => w.id === "b-normal")!;
    expect(a.queuedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(b.queuedAt).toBeNull();
  });
});

describe("recent enrichment", () => {
  it("populates result fields from the junco-result block; legacy files → null", async () => {
    const d = setupDirs();
    writeFileSync(
      join(d.done, "2026-07-07T1002Z__gh-acme-api-7.md"),
      "---\nid: gh-acme-api-7\ngithub:\n  nwo: acme/api\n  issue: 7\n  kind: pr\n---\n\nbody\n\n" +
        "---\n<!-- junco-result\nstatus: timeout_partial\nduration_seconds: 61\n" +
        "pr_url: https://github.com/acme/api/pull/7\npushed: true\n-->\n\n## Result\n\nok\n",
    );
    writeTicket(d.done, "2026-07-07T1001Z__legacy-1.md", "id: legacy-1"); // no result block
    const statFn = (p: string): { mtimeMs: number } => {
      if (p.includes("gh-acme-api-7")) return { mtimeMs: 2000 };
      if (p.includes("legacy-1")) return { mtimeMs: 1000 };
      return { mtimeMs: 0 };
    };
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), {
      fetchFn: downFetch,
      statFn,
    })();
    const enriched = snap.recent.find((r) => r.id === "gh-acme-api-7")!;
    expect(enriched.resultStatus).toBe("timeout_partial");
    expect(enriched.durationSeconds).toBe(61);
    expect(enriched.prUrl).toBe("https://github.com/acme/api/pull/7");
    const legacy = snap.recent.find((r) => r.id === "legacy-1")!;
    expect(legacy.resultStatus).toBeNull();
    expect(legacy.durationSeconds).toBeNull();
    expect(legacy.prUrl).toBeNull();
    // The legacy row is otherwise identical to today's shape.
    expect(legacy).toMatchObject({ id: "legacy-1", status: "done", github: null });
  });
});

describe("stats", () => {
  const NOW = new Date("2026-07-15T12:00:00.000Z");

  function writeShard(dataDir: string, records: unknown[]): void {
    const dir = join(dataDir, "history");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "tasks-2026-07.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  }

  const doneRec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    v: 1,
    at: "2026-07-15T10:00:00.000Z",
    id: "x",
    kind: "pr",
    status: "completed",
    durationSeconds: 100,
    tokensIn: 10,
    tokensOut: 20,
    costUsd: 0.5,
    retryCount: 0,
    ...over,
  });

  it("populates stats from the health body, ledger shard, and outbox dirs", async () => {
    const d = setupDirs();
    const dataDir = join(d.root, "state");
    const cfg = makeQueueCfg(d.root, { dataDir } as Partial<Config>);
    writeShard(dataDir, [doneRec()]);
    const obx = join(dataDir, "outbox");
    mkdirSync(join(obx, "dead"), { recursive: true });
    writeFileSync(join(obx, "1-0-a-labels.json"), "{}");
    writeFileSync(join(obx, "2-0-b-labels.json"), "{}");
    writeFileSync(join(obx, "dead", "3-0-c-labels.json"), "{}");

    const healthOverride = {
      body: {
        status: "ok",
        ready: true,
        metrics: {
          lastPollAt: "2026-07-15T11:59:00.000Z",
          currentTickets: [],
          currentProgress: {},
        },
        gate: { state: "cooldown", reason: "rate limited", until: null },
      } as unknown as HealthBody,
    };
    // healthOverride is a per-INVOCATION option (#235) — the factory stays
    // hoistable with its shard memo intact.
    const snap = await makeQueueSnapshotFn(cfg, { nowFn: () => NOW })({ healthOverride });
    expect(snap.stats).not.toBeNull();
    expect(snap.stats!.gate?.state).toBe("cooldown");
    expect(snap.stats!.lastPollAt).toBe("2026-07-15T11:59:00.000Z");
    expect(snap.stats!.window24h.done).toBe(1);
    expect(snap.stats!.outbox).toEqual({ depth: 2, dead: 1 });
  });

  it("self-fetch path parses the FULL health body into stats.gate", async () => {
    const d = setupDirs();
    const cfg = makeQueueCfg(d.root, { dataDir: join(d.root, "state") } as Partial<Config>);
    const body = {
      status: "ok",
      ready: true,
      metrics: { currentTickets: [], currentProgress: {}, lastPollAt: "2026-07-15T00:00:00Z" },
      gate: { state: "open", reason: null, until: null },
    };
    const fetchFn = (async () => ({
      ok: true,
      json: async () => body,
    })) as unknown as typeof fetch;
    const snap = await makeQueueSnapshotFn(cfg, { fetchFn, nowFn: () => NOW })();
    expect(snap.daemonUp).toBe(true);
    expect(snap.stats!.gate?.state).toBe("open");
  });

  it("ETA uses the eligible (non-deferred) waiting count, not the total", async () => {
    const d = setupDirs();
    const dataDir = join(d.root, "state");
    const cfg = makeQueueCfg(d.root, { dataDir } as Partial<Config>); // maxConcurrent 1
    const future = new Date(NOW.getTime() + 3600_000).toISOString();
    writeTicket(d.inbox, "a.md", `id: a\nnot_before: "${future}"`); // deferred
    writeTicket(d.inbox, "b.md", "id: b"); // eligible
    writeTicket(d.inbox, "c.md", "id: c"); // eligible
    writeShard(dataDir, [doneRec()]); // avgDurationSeconds → 100
    const snap = await makeQueueSnapshotFn(cfg, { fetchFn: downFetch, nowFn: () => NOW })();
    expect(snap.stats!.window24h.avgDurationSeconds).toBe(100);
    // 2 eligible × 100s / 1 concurrent = 200 (NOT 3 total × 100 = 300).
    expect(snap.stats!.etaSeconds).toBe(200);
  });
});
