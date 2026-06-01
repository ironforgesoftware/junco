/**
 * Loop-guard classes ported from Python (worker.py).
 *
 * These are PURE logic — no I/O, no SDK. They observe primitive inputs and
 * return whether they "trip". A later task wires them to the live event stream.
 *
 * Thresholds and trip logic must match the Python EXACTLY — they are the
 * empirically-tuned crown jewel of Junco's supervisor.
 *
 * Reference: worker.py RepetitionGuard ~675–726, DEFAULT_TOOL_LOOP_THRESHOLDS
 * ~738–747, ToolCallLoopGuard ~750–814, ToolErrorLoopGuard ~817–858,
 * OutputBudgetGuard ~861–927.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Per-tool thresholds for ToolCallLoopGuard
// ---------------------------------------------------------------------------

/**
 * Per-tool thresholds for ToolCallLoopGuard. Identical-args repetition is
 * always a loop for read-only verify tools (bash, grep, find, glob): same
 * args = same output; calling 3+ times is wasted compute. Edit/write tools
 * get slightly more room because exploratory edits are legitimate.
 *
 * Mirrors DEFAULT_TOOL_LOOP_THRESHOLDS in worker.py exactly.
 */
export const DEFAULT_TOOL_LOOP_THRESHOLDS: Record<string, number> = {
  bash: 3,
  grep: 3,
  find: 3,
  glob: 3,
  write: 3,
  edit: 4,
  read: 5,
  todo_write: 4,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stringify `value` with recursively sorted object keys — mirrors Python's
 * `json.dumps(args, sort_keys=True, default=str)`.
 */
function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // Primitives: let JSON.stringify handle them (including undefined → "undefined"
    // edge-case handled by fallback in caller).
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableJsonStringify).join(",") + "]";
  }
  // Object: sort keys, recurse.
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  const pairs = sorted.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return JSON.stringify(k) + ":" + stableJsonStringify(v);
  });
  return "{" + pairs.join(",") + "}";
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack` — mirrors
 * Python's `str.count(sub)` which is non-overlapping left-to-right.
 */
function strCount(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// RepetitionGuard
// ---------------------------------------------------------------------------

/**
 * Detects text-repetition loops inside a single streaming turn.
 *
 * Takes the latest cumulative text (from a `message_update` / `message_end`
 * event's content[] block — either `text` or `thinking`) and checks whether
 * the tail of that text appears repeatedly within a rolling window. This
 * catches the 'model keeps regenerating the same paragraph until max_tokens'
 * failure mode that tool-call-level guards can't see.
 *
 * Mirrors Python RepetitionGuard exactly (worker.py ~675–726).
 */
export class RepetitionGuard {
  private readonly windowChars: number;
  private readonly probeChars: number;
  private readonly threshold: number;
  private readonly minChars: number;

  tripped: boolean = false;
  lastProbe: string | null = null;
  lastCount: number = 0;
  /** Used later by the nudge builder. Default null. */
  lastName: string | null = null;

  constructor(
    windowChars: number = 2000,
    probeChars: number = 200,
    threshold: number = 4,
    minChars: number = 1000,
  ) {
    this.windowChars = windowChars;
    this.probeChars = probeChars;
    this.threshold = threshold;
    this.minChars = minChars;
  }

  /**
   * Feed the latest snapshot of a streaming message's text/thinking.
   * Returns true iff the guard wants to abort.
   */
  update(cumulativeText: unknown): boolean {
    if (typeof cumulativeText !== "string" || cumulativeText.length < this.minChars) {
      return false;
    }
    const tail =
      cumulativeText.length > this.windowChars
        ? cumulativeText.slice(-this.windowChars)
        : cumulativeText;
    const probeLen = Math.min(this.probeChars, Math.floor(tail.length / 3));
    if (probeLen < 80) {
      return false;
    }
    const probe = tail.slice(-probeLen);
    // Don't fire on trivial repeats (e.g. whitespace, single-character runs).
    // Python: len(set(probe.strip())) < 10
    const uniqueChars = new Set(probe.trim()).size;
    if (uniqueChars < 10) {
      return false;
    }
    const count = strCount(tail, probe);
    this.lastProbe = probe;
    this.lastCount = count;
    if (count >= this.threshold) {
      this.tripped = true;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// ToolCallLoopGuard
// ---------------------------------------------------------------------------

/**
 * Detects literal-repetition tool-call loops at turn boundary.
 *
 * Trips when the same `(toolName, argHash)` is observed `threshold` times
 * consecutively. argHash is sha1(stableJsonStringify(args)).hex[:12], mirroring
 * Python's `hashlib.sha1(json.dumps(args, sort_keys=True, default=str)).hexdigest()[:12]`.
 *
 * Mirrors Python ToolCallLoopGuard exactly (worker.py ~750–814).
 */
export class ToolCallLoopGuard {
  private readonly thresholdMap: Record<string, number>;
  private readonly defaultThreshold: number;
  private lastSig: string | null = null;
  private runLen: number = 0;

  tripped: boolean = false;
  lastName: string | null = null;
  lastCount: number = 0;
  lastThreshold: number = 0;

  constructor(
    thresholdMap: Record<string, number> | null = null,
    defaultThreshold: number = 4,
  ) {
    this.thresholdMap =
      thresholdMap !== null
        ? { ...thresholdMap }
        : { ...DEFAULT_TOOL_LOOP_THRESHOLDS };
    this.defaultThreshold = defaultThreshold;
  }

  /**
   * Feed one observed tool call. Returns true iff the guard trips.
   */
  observe(name: string, args: unknown): boolean {
    let argHash: string;
    try {
      const json = stableJsonStringify(args);
      argHash = createHash("sha1").update(json).digest("hex").slice(0, 12);
    } catch {
      argHash = String(args).slice(0, 64);
    }
    const sig = name + " " + argHash;
    if (sig === this.lastSig) {
      this.runLen++;
    } else {
      this.lastSig = sig;
      this.runLen = 1;
    }
    const threshold = this.thresholdMap[name] ?? this.defaultThreshold;
    if (this.runLen >= threshold) {
      this.tripped = true;
      this.lastName = String(name);
      this.lastCount = this.runLen;
      this.lastThreshold = threshold;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// ToolErrorLoopGuard
// ---------------------------------------------------------------------------

/**
 * Detects consecutive-error loops on the same tool.
 *
 * Distinct from ToolCallLoopGuard: that one trips on identical *args*; this
 * trips when args differ but every result is an error for the same tool.
 *
 * Uses a SEPARATE internal field (_lastNameInternal) for reset-tracking vs
 * the public `lastName` that is only set on trip — mirrors Python's
 * `_last_name` (internal) and `last_name` (public).
 *
 * Mirrors Python ToolErrorLoopGuard exactly (worker.py ~817–858).
 */
export class ToolErrorLoopGuard {
  private readonly threshold: number;
  private _lastNameInternal: string | null = null;
  private runLen: number = 0;

  tripped: boolean = false;
  lastName: string | null = null;
  lastCount: number = 0;

  constructor(threshold: number = 3) {
    this.threshold = threshold;
  }

  /**
   * Feed one observed tool result. Returns true iff the guard trips.
   */
  observe(name: string, isError: boolean): boolean {
    if (!isError) {
      this._lastNameInternal = null;
      this.runLen = 0;
      return false;
    }
    if (name === this._lastNameInternal) {
      this.runLen++;
    } else {
      this._lastNameInternal = name;
      this.runLen = 1;
    }
    if (this.runLen >= this.threshold) {
      this.tripped = true;
      this.lastName = String(name);
      this.lastCount = this.runLen;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// OutputBudgetGuard
// ---------------------------------------------------------------------------

/**
 * Caps per-turn output tokens.
 *
 * Catches the failure mode where the model generates massive output without
 * converging on a state-changing tool call. Pre-commit budget is tighter
 * (12k); post-commit is looser (24k).
 *
 * Mirrors Python OutputBudgetGuard exactly (worker.py ~861–927).
 */
export class OutputBudgetGuard {
  private readonly preCommitBudget: number;
  private readonly postCommitBudget: number;

  turnOutputTokens: number = 0;
  commitsMade: number = 0;
  tripped: boolean = false;
  lastName: string = "output_budget";
  lastCount: number = 0;
  lastThreshold: number = 0;

  constructor(preCommitBudget: number = 12000, postCommitBudget: number = 24000) {
    this.preCommitBudget = preCommitBudget;
    this.postCommitBudget = postCommitBudget;
  }

  get currentBudget(): number {
    return this.commitsMade > 0 ? this.postCommitBudget : this.preCommitBudget;
  }

  /**
   * Add tokens from one message_end event to turn total.
   * Returns true if budget exceeded.
   */
  observeOutputTokens(n: unknown): boolean {
    if (!Number.isInteger(n) || (n as number) <= 0) {
      return false;
    }
    this.turnOutputTokens += n as number;
    const budget = this.currentBudget;
    if (this.turnOutputTokens > budget) {
      this.tripped = true;
      this.lastCount = this.turnOutputTokens;
      this.lastThreshold = budget;
      return true;
    }
    return false;
  }

  /**
   * Mark that a state-changing commit was made. Raises future budget.
   */
  observeCommit(): void {
    this.commitsMade++;
  }

  /**
   * Called on `turn_end`: a new turn starts, reset the per-turn counter.
   * The `tripped` flag is NOT cleared — once tripped, the supervisor's
   * decision stands for the session.
   */
  resetTurn(): void {
    this.turnOutputTokens = 0;
  }
}
