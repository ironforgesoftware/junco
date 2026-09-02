// TZ must be pinned before any Date-touching import runs, so this is the
// very first statement in the file (ahead of the `import`s below).
process.env.TZ = "America/New_York";

import { describe, it, expect } from "vitest";
import { buildQueueStats } from "../src/tui/queueStats.js";
import type { Config } from "../src/types.js";
import type { TaskRecord } from "../src/taskHistory.js";

// Guard: only run the DST scenario if this environment actually honors
// process.env.TZ AND America/New_York observes DST the way the fixed dates
// below assume (2027-03-14 is the US spring-forward date that year — clocks
// jump 2am->3am EST->EDT partway through the day, so local midnight on the
// 14th is still EST while local midnight on the 15th is EDT). Comparing
// against a plain winter date like Jan 1 would NOT detect this: Jan 1 and
// Mar-14-at-midnight are both EST, so that comparison is always equal and
// would skip the test even in an environment where TZ pinning works fully.
// Some ICU builds also ignore process.env.TZ once the process has started;
// without this guard an unpinned run would silently pass or fail for the
// wrong reason.
const observesDst =
  new Date(2027, 2, 14).getTimezoneOffset() !== new Date(2027, 2, 15).getTimezoneOffset();

// Loud skip, in the spirit of sandbox.integration.test.ts: no CI leg guarantees
// this environment honors the TZ pin, so a silent skip is indistinguishable
// from DST coverage that actually ran. Written straight to stderr, NOT via
// console.warn: vitest captures console.* and only replays it under a failing
// test, so a module-load warning (no test to attach to) never reaches the
// terminal — verified on vitest 4.1.11, for skipped AND passing files.
if (!observesDst) {
  process.stderr.write(
    `\n!! queueStatsDst.test.ts — process.env.TZ=America/New_York is NOT honored here ` +
      `(2027-03-14 and 2027-03-15 report the same UTC offset, so no spring-forward is observable); ` +
      `the DST bucket case is SKIPPED, not covered.\n`,
  );
}

/** Minimal config (same cast-through-unknown style as queueStats.test.ts). */
function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    queueRoot: "/q",
    dataDir: "/data",
    defaultTimeoutMinutes: 30,
    maxConcurrent: 2,
    healthEnabled: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    ...overrides,
  } as unknown as Config;
}

function makeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    v: 1,
    at: new Date(2027, 2, 14, 12).toISOString(),
    id: "t1",
    kind: "pr",
    status: "completed",
    durationSeconds: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    retryCount: 0,
    ...overrides,
  };
}

const emptyOutbox = { depth: 0, dead: 0 };

describe.skipIf(!observesDst)("buildQueueStats perDay7d — DST (America/New_York)", () => {
  it("spring-forward 2027-03-14: every record in the 7d window lands in a bucket", () => {
    // "Now" is the local instant 2027-03-15T00:30 America/New_York — the day
    // after spring-forward, so a fixed-24h walk backward from here steps
    // over the 23-hour DST day and skips its calendar-day key entirely.
    const now = new Date(2027, 2, 15, 0, 30);
    const recs: TaskRecord[] = [
      // Falls on the skipped DST day (2027-03-14 local).
      makeRecord({
        id: "dst-day",
        at: new Date(2027, 2, 14, 12).toISOString(),
        status: "completed",
      }),
      // A normal day, unaffected either way — sanity control.
      makeRecord({
        id: "prior-day",
        at: new Date(2027, 2, 13, 12).toISOString(),
        status: "timeout",
      }),
    ];
    const stats = buildQueueStats(
      makeCfg(),
      { healthBody: null, history: () => recs, eligibleWaiting: 0, outbox: emptyOutbox },
      { nowFn: () => now },
    );
    const total = stats.perDay7d.reduce((sum, day) => sum + day.done + day.failed, 0);
    expect(total).toBe(2);
  });
});
