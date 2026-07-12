import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { makeSpendLedger } from "../src/spendLedger.js";
import { log } from "../src/logging.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "junco-spend-"));
}

// Local timestamps (NOT UTC) — mirrors the source's local-date discipline.
const DAY1_NOON = new Date(2026, 6, 11, 12, 0, 0, 0).getTime(); // 2026-07-11 noon
const DAY1_LATE = new Date(2026, 6, 11, 23, 59, 0, 0).getTime(); // 2026-07-11 23:59
const DAY2_EARLY = new Date(2026, 6, 12, 0, 0, 30, 0).getTime(); // 2026-07-12 00:00:30

describe("makeSpendLedger", () => {
  it("todayUsd() is 0 when no file exists yet", () => {
    const dir = tmp();
    const ledger = makeSpendLedger(dir, { now: () => DAY1_NOON });
    expect(ledger.todayUsd()).toBe(0);
  });

  it("recordUsd accumulates across calls on the same local day", () => {
    const dir = tmp();
    const ledger = makeSpendLedger(dir, { now: () => DAY1_NOON });
    ledger.recordUsd(1.5);
    ledger.recordUsd(2.25);
    expect(ledger.todayUsd()).toBeCloseTo(3.75);
  });

  it("recordUsd(0) is a no-op — skips the write entirely, no warn", () => {
    const dir = tmp();
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const ledger = makeSpendLedger(dir, { now: () => DAY1_NOON });
    ledger.recordUsd(0);
    expect(existsSync(join(dir, "spend.json"))).toBe(false);
    expect(ledger.todayUsd()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("recordUsd(NaN) must NOT zero the day: prior total survives, file stays valid, warn fires", () => {
    const dir = tmp();
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const ledger = makeSpendLedger(dir, { now: () => DAY1_NOON });
    ledger.recordUsd(47);

    ledger.recordUsd(NaN); // one bad SDK float

    expect(ledger.todayUsd()).toBeCloseTo(47); // NOT 0 — the day's spend is not discarded
    const raw = JSON.parse(readFileSync(join(dir, "spend.json"), "utf8")) as {
      date: string;
      usd: number;
    };
    expect(raw.usd).toBeCloseTo(47); // still valid JSON, not `null`
    expect(warnSpy).toHaveBeenCalled(); // a bad float must be visible
  });

  it("recordUsd(Infinity) is rejected the same way: total survives, warn fires", () => {
    const dir = tmp();
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const ledger = makeSpendLedger(dir, { now: () => DAY1_NOON });
    ledger.recordUsd(47);

    ledger.recordUsd(Infinity);
    ledger.recordUsd(-Infinity);

    expect(ledger.todayUsd()).toBeCloseTo(47);
    const raw = JSON.parse(readFileSync(join(dir, "spend.json"), "utf8")) as { usd: number };
    expect(raw.usd).toBeCloseTo(47);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("recordUsd(-5) is silently skipped — no refund semantics, no write, no warn", () => {
    const dir = tmp();
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const ledger = makeSpendLedger(dir, { now: () => DAY1_NOON });
    ledger.recordUsd(3);
    const before = readFileSync(join(dir, "spend.json"), "utf8");

    ledger.recordUsd(-5);

    expect(ledger.todayUsd()).toBeCloseTo(3);
    expect(readFileSync(join(dir, "spend.json"), "utf8")).toBe(before); // no write
    expect(warnSpy).not.toHaveBeenCalled(); // silent skip, unlike non-finite
  });

  it("persists to spend.json under the state dir in the documented shape", () => {
    const dir = tmp();
    const ledger = makeSpendLedger(dir, { now: () => DAY1_NOON });
    ledger.recordUsd(4.2);
    const raw = JSON.parse(readFileSync(join(dir, "spend.json"), "utf8")) as {
      date: string;
      usd: number;
    };
    expect(raw.date).toBe("2026-07-11");
    expect(raw.usd).toBeCloseTo(4.2);
  });

  it("a read after the clock crosses midnight reports 0 WITHOUT writing", () => {
    const dir = tmp();
    let now = DAY1_LATE;
    const ledger = makeSpendLedger(dir, { now: () => now });
    ledger.recordUsd(5);
    const before = readFileSync(join(dir, "spend.json"), "utf8");

    now = DAY2_EARLY; // cross midnight
    expect(ledger.todayUsd()).toBe(0);

    // File on disk is untouched — todayUsd() never writes.
    expect(readFileSync(join(dir, "spend.json"), "utf8")).toBe(before);
  });

  it("recordUsd after midnight rolls over instead of accumulating onto the old day", () => {
    const dir = tmp();
    let now = DAY1_LATE;
    const ledger = makeSpendLedger(dir, { now: () => now });
    ledger.recordUsd(5);

    now = DAY2_EARLY;
    ledger.recordUsd(2);

    expect(ledger.todayUsd()).toBeCloseTo(2); // not 7
    const raw = JSON.parse(readFileSync(join(dir, "spend.json"), "utf8")) as {
      date: string;
      usd: number;
    };
    expect(raw.date).toBe("2026-07-12");
    expect(raw.usd).toBeCloseTo(2);
  });

  it("corrupt JSON file → 0, never throws", () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "spend.json"), "{ not json", "utf8");
    const ledger = makeSpendLedger(dir, { now: () => DAY1_NOON });
    expect(() => ledger.todayUsd()).not.toThrow();
    expect(ledger.todayUsd()).toBe(0);
  });

  it("missing/malformed shape (wrong types) → 0, never throws", () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "spend.json"), JSON.stringify({ date: 42, usd: "nope" }), "utf8");
    const ledger = makeSpendLedger(dir, { now: () => DAY1_NOON });
    expect(ledger.todayUsd()).toBe(0);
  });

  it("unreadable file (fs throws) → 0, never throws", () => {
    const dir = tmp();
    const ledger = makeSpendLedger(dir, {
      now: () => DAY1_NOON,
      readFileFn: () => {
        throw new Error("boom: permission denied");
      },
    });
    expect(() => ledger.todayUsd()).not.toThrow();
    expect(ledger.todayUsd()).toBe(0);
  });

  it("uses the watchlist.ts atomic discipline: writeFileFn gets the .tmp path, renameFn moves it into place", () => {
    const dir = tmp();
    const file = join(dir, "spend.json");
    const writeFileFn = vi.fn(writeFileSync);
    const renameFn = vi.fn(renameSync);
    const mkdirFn = vi.fn(mkdirSync);
    const ledger = makeSpendLedger(dir, {
      now: () => DAY1_NOON,
      writeFileFn,
      renameFn,
      mkdirFn,
    });

    ledger.recordUsd(1);

    expect(mkdirFn).toHaveBeenCalledWith(dirname(file), { recursive: true });
    expect(writeFileFn).toHaveBeenCalledTimes(1);
    expect(writeFileFn.mock.calls[0]?.[0]).toBe(file + ".tmp");
    expect(renameFn).toHaveBeenCalledTimes(1);
    expect(renameFn).toHaveBeenCalledWith(file + ".tmp", file);
    // No leftover tmp file after the rename.
    expect(existsSync(file + ".tmp")).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it("nextMidnightMs() is the start of the next LOCAL day per the injected clock", () => {
    const dir = tmp();
    const ledger = makeSpendLedger(dir, { now: () => DAY1_NOON });
    expect(ledger.nextMidnightMs()).toBe(new Date(2026, 6, 12, 0, 0, 0, 0).getTime());
  });

  it("nextMidnightMs() just after midnight is the FOLLOWING midnight, not the one just passed", () => {
    const dir = tmp();
    const ledger = makeSpendLedger(dir, { now: () => DAY2_EARLY });
    expect(ledger.nextMidnightMs()).toBe(new Date(2026, 6, 13, 0, 0, 0, 0).getTime());
  });

  it("defaults now() to Date.now when no clock is injected", () => {
    const dir = tmp();
    const ledger = makeSpendLedger(dir);
    expect(ledger.todayUsd()).toBe(0);
    expect(ledger.nextMidnightMs()).toBeGreaterThan(Date.now());
  });
});
