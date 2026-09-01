import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  appendTaskRecord,
  makeTaskHistoryReader,
  readTaskHistory,
  type TaskRecord,
} from "../src/taskHistory.js";
import type { Config } from "../src/types.js";

// Minimal cfg: taskHistory reads only dataDir. Cast through unknown like the
// other store suites do for narrow-surface fixtures.
const cfg = { dataDir: "/data" } as unknown as Config;

const rec = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  v: 1,
  at: "2026-07-19T10:00:00.000Z",
  id: "t-1",
  kind: "pr",
  status: "completed",
  durationSeconds: 120,
  tokensIn: 1000,
  tokensOut: 200,
  costUsd: 0.05,
  retryCount: 0,
  ...over,
});

describe("appendTaskRecord", () => {
  it("mkdir -p's the history dir and appends one JSON line to the UTC-month shard", () => {
    const mk: string[] = [];
    const appended: Array<{ p: string; s: string }> = [];
    appendTaskRecord(cfg, rec(), {
      mkdirFn: ((d: string) => void mk.push(d)) as never,
      appendFn: ((p: string, s: string) => void appended.push({ p, s })) as never,
    });
    expect(mk).toEqual([join("/data", "history")]);
    expect(appended).toHaveLength(1);
    expect(appended[0].p).toBe(join("/data", "history", "tasks-2026-07.jsonl"));
    expect(appended[0].s.endsWith("\n")).toBe(true);
    expect(JSON.parse(appended[0].s) as TaskRecord).toEqual(rec());
  });

  it("never throws when the append fails", () => {
    expect(() =>
      appendTaskRecord(cfg, rec(), {
        mkdirFn: (() => {
          throw new Error("EROFS");
        }) as never,
      }),
    ).not.toThrow();
  });

  it("carries the optional mode field through to the appended JSON line (v:1 unchanged — additive)", () => {
    const record = rec({ mode: "apply" });
    expect(record.v).toBe(1);
    const appended: Array<{ p: string; s: string }> = [];
    appendTaskRecord(cfg, record, {
      mkdirFn: (() => {}) as never,
      appendFn: ((p: string, s: string) => void appended.push({ p, s })) as never,
    });
    expect(JSON.parse(appended[0].s) as TaskRecord).toEqual(record);
    expect((JSON.parse(appended[0].s) as TaskRecord).mode).toBe("apply");
  });

  it("an omitted mode round-trips as undefined — legacy (pre-mode) records still parse", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const realCfg = {
      dataDir: mkdtempSync(join(tmpdir(), "junco-hist-mode-")),
    } as unknown as Config;
    const record = rec({ id: "legacy-no-mode" }); // no mode field at all
    appendTaskRecord(realCfg, record);
    const back = readTaskHistory(realCfg, { since: new Date("2026-07-01T00:00:00Z") });
    expect(back).toHaveLength(1);
    expect(back[0].mode).toBeUndefined();
  });
});

describe("makeTaskHistoryReader", () => {
  const NOW = new Date("2026-07-19T12:00:00Z");
  const shard = (recs: (TaskRecord | string)[]): string =>
    recs.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";

  it("reads only shards overlapping [since, now] and filters by at >= since", () => {
    const files: Record<string, string> = {
      [join("/data", "history", "tasks-2026-06.jsonl")]: shard([
        rec({ at: "2026-06-30T23:00:00.000Z", id: "june" }),
      ]),
      [join("/data", "history", "tasks-2026-07.jsonl")]: shard([
        rec({ at: "2026-07-11T00:00:00.000Z", id: "old" }),
        rec({ at: "2026-07-19T01:00:00.000Z", id: "fresh" }),
      ]),
    };
    const read = makeTaskHistoryReader(cfg, {
      readFileFn: (p: string) => {
        if (!(p in files)) throw new Error("ENOENT");
        return files[p];
      },
      statFn: (p: string) => {
        if (!(p in files)) throw new Error("ENOENT");
        return { mtimeMs: 1 };
      },
      nowFn: () => NOW,
    });
    // 7d window: only the July shard qualifies; only "fresh" is inside it.
    expect(read(new Date("2026-07-12T12:00:00Z")).map((r) => r.id)).toEqual(["fresh"]);
    // 30d window spans June + July.
    expect(read(new Date("2026-06-20T00:00:00Z")).map((r) => r.id)).toEqual([
      "june",
      "old",
      "fresh",
    ]);
  });

  it("skips corrupt and alien-shaped lines", () => {
    const p = join("/data", "history", "tasks-2026-07.jsonl");
    const files: Record<string, string> = {
      [p]: shard([rec({ id: "good" }), "{not json", JSON.stringify({ hello: "world" }), ""]),
    };
    const read = makeTaskHistoryReader(cfg, {
      readFileFn: (q: string) =>
        files[q] ??
        ((): never => {
          throw new Error("ENOENT");
        })(),
      statFn: () => ({ mtimeMs: 1 }),
      nowFn: () => NOW,
    });
    expect(read(new Date("2026-07-01T00:00:00Z")).map((r) => r.id)).toEqual(["good"]);
  });

  it("memoizes per shard on mtimeMs and re-reads when it changes", () => {
    let content = shard([rec({ id: "a" })]);
    let mtime = 1;
    let reads = 0;
    const read = makeTaskHistoryReader(cfg, {
      readFileFn: () => {
        reads++;
        return content;
      },
      statFn: () => ({ mtimeMs: mtime }),
      nowFn: () => NOW,
    });
    const since = new Date("2026-07-01T00:00:00Z");
    read(since);
    read(since);
    expect(reads).toBe(1); // second call served from memo
    content = shard([rec({ id: "a" }), rec({ id: "b" })]);
    mtime = 2;
    expect(read(since).map((r) => r.id)).toEqual(["a", "b"]);
    expect(reads).toBe(2);
  });

  it("missing dir/shards yield [] and a since in the future yields []", () => {
    const read = makeTaskHistoryReader(cfg, {
      readFileFn: () => {
        throw new Error("ENOENT");
      },
      statFn: () => {
        throw new Error("ENOENT");
      },
      nowFn: () => NOW,
    });
    expect(read(new Date("2026-07-01T00:00:00Z"))).toEqual([]);
    expect(read(new Date("2027-01-01T00:00:00Z"))).toEqual([]);
  });
});

describe("readTaskHistory", () => {
  it("is a one-shot wrapper over the reader", () => {
    const p = join("/data", "history", "tasks-2026-07.jsonl");
    const files: Record<string, string> = { [p]: JSON.stringify(rec({ id: "x" })) + "\n" };
    const out = readTaskHistory(
      cfg,
      { since: new Date("2026-07-01T00:00:00Z") },
      {
        readFileFn: (q: string) =>
          files[q] ??
          ((): never => {
            throw new Error("ENOENT");
          })(),
        statFn: () => ({ mtimeMs: 1 }),
        nowFn: () => new Date("2026-07-19T12:00:00Z"),
      },
    );
    expect(out.map((r) => r.id)).toEqual(["x"]);
  });
});

describe("coverage additions (#236)", () => {
  it("monthsBetween Dec→Jan rollover: a window straddling the year boundary reads both shards", () => {
    const files: Record<string, string> = {
      [join("/data", "history", "tasks-2026-12.jsonl")]:
        JSON.stringify(rec({ at: "2026-12-20T10:00:00.000Z", id: "december" })) + "\n",
      [join("/data", "history", "tasks-2027-01.jsonl")]:
        JSON.stringify(rec({ at: "2027-01-05T10:00:00.000Z", id: "january" })) + "\n",
    };
    const read = makeTaskHistoryReader(cfg, {
      readFileFn: (p: string) => {
        if (!(p in files)) throw new Error("ENOENT");
        return files[p];
      },
      statFn: (p: string) => {
        if (!(p in files)) throw new Error("ENOENT");
        return { mtimeMs: 1 };
      },
      nowFn: () => new Date("2027-01-10T12:00:00Z"),
    });
    // since mid-December, now mid-January: the m===12 → m=0,y++ arm runs and
    // BOTH shards are enumerated (oldest first).
    expect(read(new Date("2026-12-15T00:00:00Z")).map((r) => r.id)).toEqual([
      "december",
      "january",
    ]);
  });

  it("real-fs round-trip: appendTaskRecord's on-disk format parses back field-for-field", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const realCfg = { dataDir: mkdtempSync(join(tmpdir(), "junco-hist-")) } as unknown as Config;
    const record = rec({ id: "round-trip", nwo: "acme/api", issue: 7, prUrl: "https://x/pr/1" });
    appendTaskRecord(realCfg, record); // real fs — no deps injected
    const back = readTaskHistory(realCfg, { since: new Date("2026-07-01T00:00:00Z") });
    expect(back).toEqual([record]);
  });
});
