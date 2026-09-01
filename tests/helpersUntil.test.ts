// tests/helpersUntil.test.ts — direct coverage for tests/helpers/until.ts.
//
// until() is the suite's most load-bearing helper, and the re-send semantics
// of fireUntil / pressUntilAdvanced are documented but were never pinned. Fake
// timers make every budget exact: a test here advances the clock instead of
// waiting on it, so "pending at 59 ms, settled at 60 ms" is a real assertion.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { until, fireUntil, pressUntilAdvanced, tick, wait, UNTIL_TRIES } from "./helpers/until.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Settled = { state: "pending" | "resolved" | "rejected"; error: unknown };

/** Observe a promise's settlement without awaiting it — and with a rejection
 * handler attached up front, so a budget that runs out while the clock is
 * being advanced is never reported as an unhandled rejection. */
function track(p: Promise<void>): Settled {
  const s: Settled = { state: "pending", error: undefined };
  void p.then(
    () => {
      s.state = "resolved";
    },
    (e: unknown) => {
      s.state = "rejected";
      s.error = e;
    },
  );
  return s;
}

/** A stdin double that records every write; `onWrite` lets a test decide
 * which of them "land" (flip the observed state) and which are dropped. */
function fakeStdin(onWrite?: (s: string) => void): {
  writes: string[];
  write: (s: string) => void;
} {
  const writes: string[] = [];
  return {
    writes,
    write: (s: string) => {
      writes.push(s);
      onWrite?.(s);
    },
  };
}

describe("until", () => {
  it("returns the moment the condition holds, without sleeping first", async () => {
    let calls = 0;
    const s = track(
      until(() => {
        calls++;
        return true;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(s.state).toBe("resolved");
    expect(calls).toBe(1);
  });

  it("exits on the poll where the condition flips, not at the end of the budget", async () => {
    let calls = 0;
    const s = track(until(() => ++calls >= 3));
    await vi.advanceTimersByTimeAsync(40); // two 20 ms sleeps
    expect(s.state).toBe("resolved");
    expect(calls).toBe(3);
  });

  it("spends exactly tries × 20 ms, then fails through expect() with a real message", async () => {
    let calls = 0;
    const s = track(
      until(() => {
        calls++;
        return false;
      }, 3),
    );
    await vi.advanceTimersByTimeAsync(59);
    expect(s.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state).toBe("rejected");
    expect(calls).toBe(4); // three polls plus the final asserting check
    expect(s.error).toBeInstanceOf(Error);
    expect((s.error as Error).message).toMatch(/expected false to be true/);
  });

  it("defaults to the documented 3 s budget (UNTIL_TRIES × 20 ms)", async () => {
    const s = track(until(() => false));
    await vi.advanceTimersByTimeAsync(UNTIL_TRIES * 20 - 1);
    expect(s.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state).toBe("rejected");
  });
});

describe("fireUntil", () => {
  it("never sends when the condition already holds", async () => {
    const stdin = fakeStdin();
    const s = track(fireUntil(stdin, "x", () => true));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.state).toBe("resolved");
    expect(stdin.writes).toEqual([]);
  });

  it("re-sends a dropped event every 50 ms, and stops the poll after one lands", async () => {
    // The first two sends are "dropped" (no listener subscribed yet); the
    // third lands. The 50 ms spacing means the landed event's effect is
    // visible at the next check, so no fourth send follows it.
    let landed = false;
    const stdin = fakeStdin(() => {
      if (stdin.writes.length === 3) landed = true;
    });
    const s = track(fireUntil(stdin, "x", () => landed));
    await vi.advanceTimersByTimeAsync(100);
    expect(stdin.writes).toEqual(["x", "x", "x"]);
    expect(s.state).toBe("pending"); // the post-send sleep is still running
    await vi.advanceTimersByTimeAsync(50);
    expect(s.state).toBe("resolved");
    await vi.advanceTimersByTimeAsync(500);
    expect(stdin.writes).toHaveLength(3); // nothing is re-sent once cond holds
  });

  it("sends once per try and fails after the budget", async () => {
    const stdin = fakeStdin();
    const s = track(fireUntil(stdin, "x", () => false, 2));
    await vi.advanceTimersByTimeAsync(99);
    expect(s.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state).toBe("rejected");
    expect(stdin.writes).toEqual(["x", "x"]);
  });
});

describe("pressUntilAdvanced", () => {
  const FROM = "1 model";
  const TO = "Which folders";
  const ENTER = "\r";

  it("returns without pressing when the target step already shows", async () => {
    const stdin = fakeStdin();
    const s = track(pressUntilAdvanced(stdin, ENTER, () => TO, FROM, TO));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.state).toBe("resolved");
    expect(stdin.writes).toEqual([]);
  });

  it("holds the press until the source step is on screen, then presses once", async () => {
    let frame: string | undefined; // nothing rendered yet
    const stdin = fakeStdin(() => {
      frame = TO; // a landed press advances the step
    });
    const s = track(pressUntilAdvanced(stdin, ENTER, () => frame, FROM, TO));
    await vi.advanceTimersByTimeAsync(0);
    expect(stdin.writes).toEqual([]); // gated: the source step is not showing
    frame = FROM;
    await vi.advanceTimersByTimeAsync(30); // next poll sees FROM → press lands
    expect(stdin.writes).toEqual([ENTER]);
    await vi.advanceTimersByTimeAsync(30); // next poll sees TO → done
    expect(s.state).toBe("resolved");
    expect(stdin.writes).toEqual([ENTER]); // a landed press is never double-submitted
  });

  it("re-presses only while the source step still shows (a dropped keystroke)", async () => {
    let frame = FROM;
    const stdin = fakeStdin(() => {
      if (stdin.writes.length === 2) frame = TO; // the first press was dropped
    });
    const s = track(pressUntilAdvanced(stdin, ENTER, () => frame, FROM, TO));
    await vi.advanceTimersByTimeAsync(60);
    expect(s.state).toBe("resolved");
    expect(stdin.writes).toEqual([ENTER, ENTER]);
  });

  it("fails after `tries` polls (30 ms each) naming the missing marker", async () => {
    const stdin = fakeStdin();
    const s = track(pressUntilAdvanced(stdin, ENTER, () => FROM, FROM, TO, 2));
    await vi.advanceTimersByTimeAsync(59);
    expect(s.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state).toBe("rejected");
    expect(stdin.writes).toEqual([ENTER, ENTER]);
    expect((s.error as Error).message).toContain(TO);
  });
});

describe("wait / tick", () => {
  it("wait(ms) resolves after exactly ms", async () => {
    const s = track(wait(100));
    await vi.advanceTimersByTimeAsync(99);
    expect(s.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state).toBe("resolved");
  });

  it("tick() is one 30 ms keystroke-settle window", async () => {
    const s = track(tick());
    await vi.advanceTimersByTimeAsync(29);
    expect(s.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state).toBe("resolved");
  });
});
