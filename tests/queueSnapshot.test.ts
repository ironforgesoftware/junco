import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeQueueSnapshotFn, stripStamp } from "../src/tui/queueSnapshot.js";
import { enqueueOp } from "../src/githubOutbox.js";
import type { Config } from "../src/types.js";

/** Minimal config over a sandboxed queue root (same cast style as dashboardCmd.test.ts). */
function makeQueueCfg(root: string, overrides: Partial<Config> = {}): Config {
  return {
    vaultRoot: root,
    juncoSubdir: "q",
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
        stale: false,
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
        stale: false,
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
        stale: true,
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

describe("outboxDepth", () => {
  it("counts queued outbox ops for the config's state dir; empty is 0", async () => {
    const d = setupDirs();
    const stateDir = join(d.root, "state");
    const cfg = makeQueueCfg(d.root, { stateDir } as Partial<Config>);

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
  });

  it("missing queue dirs (fresh install) → empty snapshot, no error", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-qsnap-empty-"));
    const snap = await makeQueueSnapshotFn(makeQueueCfg(root), { fetchFn: downFetch })();
    expect(snap).toMatchObject({ waiting: [], running: [], recent: [], error: null });
  });
});
