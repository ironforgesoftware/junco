/**
 * Tests for the four loop-guard classes ported from Python (worker.py).
 * Written FIRST (TDD) — these are expected to fail until guards.ts is implemented.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_TOOL_LOOP_THRESHOLDS,
  RepetitionGuard,
  ToolCallLoopGuard,
  ToolErrorLoopGuard,
  OutputBudgetGuard,
} from "../src/agent/guards.js";

// ---------------------------------------------------------------------------
// DEFAULT_TOOL_LOOP_THRESHOLDS
// ---------------------------------------------------------------------------

describe("DEFAULT_TOOL_LOOP_THRESHOLDS", () => {
  it("has the exact documented thresholds", () => {
    expect(DEFAULT_TOOL_LOOP_THRESHOLDS).toEqual({
      bash: 3,
      grep: 3,
      find: 3,
      glob: 3,
      write: 3,
      edit: 4,
      read: 5,
      todo_write: 4,
    });
  });
});

// ---------------------------------------------------------------------------
// RepetitionGuard
// ---------------------------------------------------------------------------

describe("RepetitionGuard", () => {
  it("returns false for non-string input", () => {
    const g = new RepetitionGuard();
    expect(g.update(42)).toBe(false);
    expect(g.tripped).toBe(false);
  });

  it("returns false below minChars (default 1000)", () => {
    const g = new RepetitionGuard();
    expect(g.update("hello world")).toBe(false);
    expect(g.update("a".repeat(500))).toBe(false); // below 1000
    expect(g.tripped).toBe(false);
  });

  it("returns false when probeLen < 80 (text just over minChars but window/3 too small)", () => {
    // tail = 1050 chars → probeLen = floor(1050/3) = 350 but also min(200, 350) = 200 ≥ 80 → would proceed.
    // Make a string exactly at 1000 chars where the window would produce probeLen < 80:
    // With windowChars=2000 and a 1000-char string, tail=1000 → probeLen = min(200, floor(1000/3)=333) = 200 ≥ 80
    // To get probeLen < 80 we need tail.length < 240 → but minChars=1000 guards that.
    // So instead we use a custom guard with larger probeChars and tiny window/3.
    // Use: window=2000, probeChars=200, min_chars=1000 — at exactly 1000 chars probe is 200 chars, which is >= 80.
    // Reproduce the < 80 path with custom params:
    const g2 = new RepetitionGuard(2000, 200, 4, 200); // minChars=200
    // 210 chars: tail=210, probeLen=min(200, floor(210/3)=70)=70 < 80 → false
    expect(g2.update("x".repeat(210))).toBe(false);
    expect(g2.tripped).toBe(false);
  });

  it("does NOT trip on trivial repeats (fewer than 10 unique chars in probe)", () => {
    const g = new RepetitionGuard();
    // All dashes — len(set(probe.strip())) < 10
    expect(g.update("-".repeat(3000))).toBe(false);
    expect(g.tripped).toBe(false);
  });

  it("does NOT trip on all-whitespace content", () => {
    const g = new RepetitionGuard();
    const text = " \n".repeat(2000);
    expect(g.update(text)).toBe(false);
    expect(g.tripped).toBe(false);
  });

  it("does NOT trip on varied prose (no 200-char substring repeats 4× in window)", () => {
    const g = new RepetitionGuard();
    const blocks = [
      "The algorithm processes incoming events sequentially, maintaining a ring buffer of the last 2048 tokens for context. Failures fall through to the default handler which logs and continues.\n\n",
      "Database migrations run during the deploy step and must complete before the new binary takes traffic. A rollback is performed if any migration exits non-zero.\n\n",
      "Frontend rendering uses a virtualised list for scroll performance. The viewport height is computed once per resize event and cached for subsequent frames.\n\n",
      "Authentication tokens are refreshed on a sliding 30-minute window. Expired tokens surface as a 401 which the client retries after a silent refresh.\n\n",
      "The caching layer is a two-tier design: an in-process LRU for hot keys and a Redis-backed store for cross-process sharing. Eviction is size-bounded at 2 GB.\n\n",
      "Logging uses structured JSON with a bounded field set to keep Datadog ingestion cheap. Unknown fields are dropped rather than sent.\n\n",
      "Error budgets are tracked per-service with a burn-rate alarm at 14.4x the monthly budget. A paging alert fires when burn exceeds the threshold for 10 minutes.\n\n",
      "Feature flags are evaluated client-side against a rule graph served from the control-plane API. Graph updates push via a SSE channel within 2 seconds.\n\n",
    ];
    const varied = blocks.join("");
    expect(varied.length).toBeGreaterThan(1000);
    expect(g.update(varied)).toBe(false);
    expect(g.tripped).toBe(false);
  });

  it("trips when a paragraph repeats 4+ times in window (threshold=4)", () => {
    const g = new RepetitionGuard();
    const probe =
      "This is an important paragraph with varied content and punctuation; worth flagging when it repeats. ".repeat(
        2,
      );
    const block = probe + "\n\n";
    const cumulative = block.repeat(5);
    expect(g.update(cumulative)).toBe(true);
    expect(g.tripped).toBe(true);
    expect(g.lastCount).toBeGreaterThanOrEqual(4);
  });

  it("does NOT trip when count is 3 (one below threshold)", () => {
    // Construct a string where the probe appears exactly 3 times.
    // Probe is the last probeLen chars of the tail. We need a tight setup.
    // Use small window/probe so we can craft exactly.
    const g = new RepetitionGuard(800, 80, 4, 200); // window=800, probe=80, threshold=4
    // We want the tail (~800 chars) to contain the probe exactly 3 times.
    // tail = last 800 chars, probe = last 80 chars.
    // Pad with enough unique prefix so probe appears 3× total in tail.
    const unit = "abcdefghij".repeat(8); // 80 chars, 10 unique chars (passes trivial check)
    // Build: [padding][unit][unit][unit] → tail ends in unit, and unit appears 3× in tail
    const padding =
      "ZZZZ_unique_prefix_text_padding_chars_here_abcXYZetcfoobar_!@#$%^&*()_=+;:?,./XXXXXX"; // ~80 chars
    const text = padding.repeat(8) + unit.repeat(3); // padding*8 + unit*3 ≈ 640+240 = 880 chars
    // tail = last 800 chars → will include the 3 unit repetitions
    // probe = last 80 chars = unit
    // count of unit in tail should be 3 → does NOT trip (threshold 4)
    const result = g.update(text);
    expect(result).toBe(false);
    expect(g.tripped).toBe(false);
    expect(g.lastCount).toBe(3);
  });

  it("trips on 4th occurrence in tail (count >= threshold)", () => {
    const g = new RepetitionGuard(800, 80, 4, 200);
    const unit = "abcdefghij".repeat(8); // 80 chars
    const padding =
      "ZZZZ_unique_prefix_text_padding_chars_here_abcXYZetcfoobar_!@#$%^&*()_=+;:?,./XXXXXX";
    // 4× unit in tail → trips
    const text = padding.repeat(8) + unit.repeat(4);
    expect(g.update(text)).toBe(true);
    expect(g.tripped).toBe(true);
    expect(g.lastCount).toBeGreaterThanOrEqual(4);
  });

  it("only looks at recent window, not ancient text", () => {
    const g = new RepetitionGuard(1500);
    const repeated =
      "REPEATED PARAGRAPH WITH ENOUGH VARIANCE TO PASS THE FLOOR CHECK AND BE DETECTABLE AS A LOOP. ".repeat(
        2,
      );
    // Old repetitions, then long diverse recent prose.
    const text = repeated.repeat(5) + ("a" + "bcdefghij".repeat(200));
    g.update(text);
    expect(g.tripped).toBe(false);
  });

  it("lastProbe and lastCount are set after evaluation", () => {
    const g = new RepetitionGuard();
    const probe =
      "This is an important paragraph with varied content and punctuation; worth flagging when it repeats. ".repeat(
        2,
      );
    const cumulative = (probe + "\n\n").repeat(5);
    g.update(cumulative);
    expect(g.lastProbe).not.toBeNull();
    expect(g.lastCount).toBeGreaterThan(0);
  });

  it("lastName field is null by default and settable", () => {
    const g = new RepetitionGuard();
    expect(g.lastName).toBeNull();
    g.lastName = "test";
    expect(g.lastName).toBe("test");
  });

  it("uses non-overlapping str.count semantics", () => {
    // Python str.count("aa" in "aaaa") == 2 (non-overlapping left-to-right)
    // Verify our implementation matches.
    const g = new RepetitionGuard(800, 80, 2, 200);
    // Craft: probe repeated exactly 2× non-overlapping → trips at threshold 2
    const unit = "abcdefghij".repeat(8); // 80 chars, 10 unique
    const padding =
      "ZZZZ_unique_prefix_text_padding_chars_here_abcXYZetcfoobar_!@#$%^&*()_=+;:?,./XXXXXX";
    const text = padding.repeat(8) + unit.repeat(2);
    expect(g.update(text)).toBe(true); // 2 occurrences >= threshold 2
  });
});

// ---------------------------------------------------------------------------
// ToolCallLoopGuard
// ---------------------------------------------------------------------------

describe("ToolCallLoopGuard", () => {
  it("trips on 3rd identical bash call (threshold=3)", () => {
    const g = new ToolCallLoopGuard();
    expect(g.observe("bash", { cmd: "ls" })).toBe(false); // run 1
    expect(g.observe("bash", { cmd: "ls" })).toBe(false); // run 2
    expect(g.observe("bash", { cmd: "ls" })).toBe(true); // run 3 → trips
    expect(g.tripped).toBe(true);
    expect(g.lastName).toBe("bash");
    expect(g.lastCount).toBe(3);
    expect(g.lastThreshold).toBe(3);
  });

  it("does NOT trip on 2nd identical bash call", () => {
    const g = new ToolCallLoopGuard();
    expect(g.observe("bash", { cmd: "ls" })).toBe(false);
    expect(g.observe("bash", { cmd: "ls" })).toBe(false);
    expect(g.tripped).toBe(false);
  });

  it("read tool requires 5 consecutive identical calls (threshold=5)", () => {
    const g = new ToolCallLoopGuard();
    for (let i = 0; i < 4; i++) {
      expect(g.observe("read", { file: "foo.ts" })).toBe(false);
    }
    expect(g.observe("read", { file: "foo.ts" })).toBe(true); // 5th → trips
    expect(g.lastThreshold).toBe(5);
  });

  it("edit tool requires 4 (threshold=4)", () => {
    const g = new ToolCallLoopGuard();
    for (let i = 0; i < 3; i++) {
      expect(g.observe("edit", { file: "x.ts", content: "abc" })).toBe(false);
    }
    expect(g.observe("edit", { file: "x.ts", content: "abc" })).toBe(true);
    expect(g.lastThreshold).toBe(4);
  });

  it("write tool threshold is 3", () => {
    const g = new ToolCallLoopGuard();
    expect(g.observe("write", { file: "a.ts" })).toBe(false);
    expect(g.observe("write", { file: "a.ts" })).toBe(false);
    expect(g.observe("write", { file: "a.ts" })).toBe(true);
    expect(g.lastThreshold).toBe(3);
  });

  it("grep threshold is 3", () => {
    const g = new ToolCallLoopGuard();
    for (let i = 0; i < 2; i++) g.observe("grep", { pattern: "foo" });
    expect(g.observe("grep", { pattern: "foo" })).toBe(true);
    expect(g.lastThreshold).toBe(3);
  });

  it("find threshold is 3", () => {
    const g = new ToolCallLoopGuard();
    for (let i = 0; i < 2; i++) g.observe("find", { path: "." });
    expect(g.observe("find", { path: "." })).toBe(true);
    expect(g.lastThreshold).toBe(3);
  });

  it("glob threshold is 3", () => {
    const g = new ToolCallLoopGuard();
    for (let i = 0; i < 2; i++) g.observe("glob", { pattern: "**/*.ts" });
    expect(g.observe("glob", { pattern: "**/*.ts" })).toBe(true);
    expect(g.lastThreshold).toBe(3);
  });

  it("todo_write threshold is 4", () => {
    const g = new ToolCallLoopGuard();
    for (let i = 0; i < 3; i++) g.observe("todo_write", { content: "x" });
    expect(g.observe("todo_write", { content: "x" })).toBe(true);
    expect(g.lastThreshold).toBe(4);
  });

  it("unknown tool defaults to threshold 4", () => {
    const g = new ToolCallLoopGuard();
    for (let i = 0; i < 3; i++) {
      expect(g.observe("web_fetch", { url: "https://example.com" })).toBe(false);
    }
    expect(g.observe("web_fetch", { url: "https://example.com" })).toBe(true);
    expect(g.lastThreshold).toBe(4);
  });

  it("different args resets the run", () => {
    const g = new ToolCallLoopGuard();
    expect(g.observe("bash", { cmd: "ls" })).toBe(false);
    expect(g.observe("bash", { cmd: "ls" })).toBe(false);
    // Different args — resets run
    expect(g.observe("bash", { cmd: "pwd" })).toBe(false); // run resets to 1
    // Another 2 identical → still only run=3 total but since reset now run=3 from new sig
    expect(g.observe("bash", { cmd: "pwd" })).toBe(false); // run=2
    expect(g.observe("bash", { cmd: "pwd" })).toBe(true); // run=3 → trips
  });

  it("stable hash: object key order does not affect matching (same args different order trips)", () => {
    const g = new ToolCallLoopGuard();
    // {a:1,b:2} and {b:2,a:1} should hash identically (stable JSON sort_keys)
    expect(g.observe("bash", { b: 2, a: 1 })).toBe(false); // run 1
    expect(g.observe("bash", { a: 1, b: 2 })).toBe(false); // run 2 — same hash
    expect(g.observe("bash", { a: 1, b: 2 })).toBe(true); // run 3 → trips
    expect(g.tripped).toBe(true);
  });

  it("stable hash works for nested objects", () => {
    const g = new ToolCallLoopGuard();
    const args1 = { x: { z: 3, y: 2 }, a: 1 };
    const args2 = { a: 1, x: { y: 2, z: 3 } };
    expect(g.observe("bash", args1)).toBe(false);
    expect(g.observe("bash", args2)).toBe(false);
    expect(g.observe("bash", args1)).toBe(true); // run 3 — all same sig
  });

  it("different tool name resets the run even with same args hash", () => {
    const g = new ToolCallLoopGuard();
    expect(g.observe("bash", { cmd: "ls" })).toBe(false);
    expect(g.observe("bash", { cmd: "ls" })).toBe(false);
    // Different tool — resets even if args happen to produce same hash
    expect(g.observe("grep", { cmd: "ls" })).toBe(false); // new tool, run=1
    expect(g.tripped).toBe(false);
  });

  it("custom thresholdMap overrides defaults", () => {
    const g = new ToolCallLoopGuard({ bash: 10 }, 4);
    for (let i = 0; i < 9; i++) {
      expect(g.observe("bash", { cmd: "ls" })).toBe(false);
    }
    expect(g.observe("bash", { cmd: "ls" })).toBe(true);
    expect(g.lastThreshold).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// ToolErrorLoopGuard
// ---------------------------------------------------------------------------

describe("ToolErrorLoopGuard", () => {
  it("trips on 3rd consecutive same-tool error (threshold=3)", () => {
    const g = new ToolErrorLoopGuard();
    expect(g.observe("bash", true)).toBe(false); // error 1
    expect(g.observe("bash", true)).toBe(false); // error 2
    expect(g.observe("bash", true)).toBe(true); // error 3 → trips
    expect(g.tripped).toBe(true);
    expect(g.lastName).toBe("bash");
    expect(g.lastCount).toBe(3);
  });

  it("does NOT trip on 2 consecutive same-tool errors", () => {
    const g = new ToolErrorLoopGuard();
    expect(g.observe("bash", true)).toBe(false);
    expect(g.observe("bash", true)).toBe(false);
    expect(g.tripped).toBe(false);
  });

  it("non-error resets the run", () => {
    const g = new ToolErrorLoopGuard();
    expect(g.observe("bash", true)).toBe(false);
    expect(g.observe("bash", true)).toBe(false);
    expect(g.observe("bash", false)).toBe(false); // success → resets
    // Now errors start fresh
    expect(g.observe("bash", true)).toBe(false); // run=1
    expect(g.observe("bash", true)).toBe(false); // run=2
    expect(g.observe("bash", true)).toBe(true); // run=3 → trips
  });

  it("different tool resets the run", () => {
    const g = new ToolErrorLoopGuard();
    expect(g.observe("bash", true)).toBe(false);
    expect(g.observe("bash", true)).toBe(false);
    expect(g.observe("grep", true)).toBe(false); // different tool → run=1
    expect(g.tripped).toBe(false);
    expect(g.observe("grep", true)).toBe(false); // run=2
    expect(g.observe("grep", true)).toBe(true); // run=3 → trips
    expect(g.lastName).toBe("grep");
  });

  it("custom threshold is respected", () => {
    const g = new ToolErrorLoopGuard(5);
    for (let i = 0; i < 4; i++) {
      expect(g.observe("bash", true)).toBe(false);
    }
    expect(g.observe("bash", true)).toBe(true);
  });

  it("lastName is null before first trip", () => {
    const g = new ToolErrorLoopGuard();
    expect(g.lastName).toBeNull();
    g.observe("bash", true);
    g.observe("bash", true);
    // Not yet tripped
    expect(g.lastName).toBeNull();
  });

  it("public lastName is only set on trip, not on each error", () => {
    // lastName (public) should only be set when guard trips.
    // _last_name (internal) tracks consecutive run — distinct from public.
    const g = new ToolErrorLoopGuard();
    g.observe("bash", true);
    g.observe("bash", true);
    expect(g.lastName).toBeNull(); // not tripped yet
    g.observe("bash", true);
    expect(g.lastName).toBe("bash"); // tripped
  });

  it("tripped stays true after non-error (reset does not clear tripped)", () => {
    const g = new ToolErrorLoopGuard();
    g.observe("bash", true);
    g.observe("bash", true);
    g.observe("bash", true); // trips
    expect(g.tripped).toBe(true);
    g.observe("bash", false); // non-error
    expect(g.tripped).toBe(true); // still tripped
  });
});

// ---------------------------------------------------------------------------
// OutputBudgetGuard
// ---------------------------------------------------------------------------

describe("OutputBudgetGuard", () => {
  it("default constructor uses documented thresholds (12000/24000)", () => {
    const g = new OutputBudgetGuard();
    expect(g["preCommitBudget"]).toBe(12000);
    expect(g["postCommitBudget"]).toBe(24000);
    expect(g.lastName).toBe("output_budget");
    expect(g.lastCount).toBe(0);
    expect(g.lastThreshold).toBe(0);
    expect(g.turnOutputTokens).toBe(0);
    expect(g.commitsMade).toBe(0);
    expect(g.tripped).toBe(false);
  });

  it("currentBudget is preCommitBudget before any commit", () => {
    const g = new OutputBudgetGuard(12000, 24000);
    expect(g.currentBudget).toBe(12000);
  });

  it("currentBudget switches to postCommitBudget after observeCommit", () => {
    const g = new OutputBudgetGuard(12000, 24000);
    g.observeCommit();
    expect(g.currentBudget).toBe(24000);
  });

  it("accumulates tokens across multiple observeOutputTokens calls", () => {
    const g = new OutputBudgetGuard(12000, 24000);
    expect(g.observeOutputTokens(5000)).toBe(false);
    expect(g.turnOutputTokens).toBe(5000);
    expect(g.observeOutputTokens(6000)).toBe(false); // cumulative = 11000
    expect(g.turnOutputTokens).toBe(11000);
  });

  it("trips when turn total exceeds pre-commit budget (>12000)", () => {
    const g = new OutputBudgetGuard(12000, 24000);
    expect(g.observeOutputTokens(5000)).toBe(false);
    expect(g.observeOutputTokens(6000)).toBe(false); // 11000
    expect(g.observeOutputTokens(2000)).toBe(true); // 13000 > 12000 → trips
    expect(g.tripped).toBe(true);
    expect(g.lastCount).toBe(13000);
    expect(g.lastThreshold).toBe(12000);
  });

  it("does NOT trip at exactly budget (must be strictly >)", () => {
    const g = new OutputBudgetGuard(12000, 24000);
    expect(g.observeOutputTokens(12000)).toBe(false); // 12000 == budget, not >
    expect(g.tripped).toBe(false);
  });

  it("does NOT trip on total between 12001–24000 after commit (post-commit budget)", () => {
    const g = new OutputBudgetGuard(12000, 24000);
    g.observeCommit();
    // 15000 > 12000 (pre-commit) but ≤ 24000 (post-commit) → no trip
    expect(g.observeOutputTokens(15000)).toBe(false);
    expect(g.tripped).toBe(false);
  });

  it("trips post-commit when total exceeds post-commit budget (>24000)", () => {
    const g = new OutputBudgetGuard(12000, 24000);
    g.observeCommit();
    expect(g.observeOutputTokens(20000)).toBe(false); // 20000 ≤ 24000
    expect(g.observeOutputTokens(5000)).toBe(true); // 25000 > 24000 → trips
    expect(g.lastThreshold).toBe(24000);
  });

  it("commit mid-turn raises budget for remainder of turn", () => {
    const g = new OutputBudgetGuard(10000, 20000);
    expect(g.observeOutputTokens(8000)).toBe(false); // under pre-commit 10000
    g.observeCommit(); // budget bumps to 20000
    expect(g.observeOutputTokens(10000)).toBe(false); // 18000 < 20000
    expect(g.observeOutputTokens(5000)).toBe(true); // 23000 > 20000 → trips
    expect(g.lastThreshold).toBe(20000);
  });

  it("resetTurn zeroes turnOutputTokens but does NOT clear tripped", () => {
    const g = new OutputBudgetGuard(12000, 24000);
    g.observeOutputTokens(5000);
    g.observeOutputTokens(6000);
    g.observeOutputTokens(2000); // trips, 13000
    expect(g.tripped).toBe(true);
    g.resetTurn();
    expect(g.turnOutputTokens).toBe(0);
    expect(g.tripped).toBe(true); // NOT cleared
  });

  it("zero or negative tokens are ignored (return false, no accumulation)", () => {
    const g = new OutputBudgetGuard(1000, 2000);
    expect(g.observeOutputTokens(0)).toBe(false);
    expect(g.observeOutputTokens(-5)).toBe(false);
    expect(g.observeOutputTokens(null)).toBe(false);
    expect(g.turnOutputTokens).toBe(0);
    expect(g.tripped).toBe(false);
  });

  it("non-integer tokens are ignored", () => {
    const g = new OutputBudgetGuard(1000, 2000);
    expect(g.observeOutputTokens(1.5)).toBe(false);
    expect(g.turnOutputTokens).toBe(0);
  });

  it("does not trip on multi-turn session with reset between turns (total session > budget)", () => {
    const g = new OutputBudgetGuard(12000, 24000);
    for (let i = 0; i < 10; i++) {
      expect(g.observeOutputTokens(3000)).toBe(false); // 3000 per turn << 12000
      g.resetTurn();
    }
    // Cumulative session = 30000, but no single turn > 12000
    expect(g.tripped).toBe(false);
  });

  it("multiple observeCommit calls accumulate (commitsMade counts up)", () => {
    const g = new OutputBudgetGuard(12000, 24000);
    g.observeCommit();
    g.observeCommit();
    expect(g.commitsMade).toBe(2);
    expect(g.currentBudget).toBe(24000); // any commits > 0 → post-commit
  });
});
