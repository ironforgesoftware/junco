# TUI Live Log View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tail the daemon's `worker.log` live from inside the TUI — a compact logs section in the LOCAL rail plus a full-screen overlay with level/ticket/text filters — reusing one shared file-tailer with `junco logs`.

**Architecture:** Extract `logsCmd`'s byte-offset follow loop into a reusable `src/logReader.ts` (parse + `readTail` + `makeLogTailer`, deps-injectable). A visibility-gated ~500 ms poll (`useLogTail`) feeds a bounded ring buffer; pure `filterEntries` narrows it; `LogView` renders the compact section and the full-screen overlay from the same rows. Spec: `docs/superpowers/specs/2026-07-20-tui-log-view-design.md`.

**Tech Stack:** TypeScript (NodeNext, strict, ESM), Ink/React TUI, vitest + ink-testing-library.

## Global Constraints

- Every side effect goes behind an injectable `*Deps` seam; tests never touch a real daemon or real fs beyond a tmp fixture.
- `npm run typecheck` (tsconfig.eslint.json) covers `tests/` — adding a member to the `LocalSection` union breaks every exhaustive `switch` over it AND the `Record<LocalSection, …>` cursor literal; each task that widens the union sweeps those in the same commit.
- Ink/TUI tests: never assert one fixed `setTimeout` tick after a state change — loop-until-condition with a bounded retry, then assert. Follow existing suites (e.g. `tests/tuiQueue.test.tsx`) for the render harness.
- Vitest exit-code trap: `npx vitest run tests/<f> > /tmp/out 2>&1; echo "exit: $?"` — never pipe into grep/tail.
- Conventional commits (`feat:`/`fix:`/`refactor:`/`docs:` with optional scope). **No AI attribution, ever** — no `Co-Authored-By: Claude`, no "Generated with Claude Code"; amend it away if a subagent commit auto-appends it.
- Prettier may reformat between read and edit; re-read before editing and run `npx prettier --write` on touched files before committing.
- Strict keyboard/mouse parity: every actionable surface responds to both (existing TUI rule).
- No new Config field. The poll interval is an internal default injected in tests via the existing `*PollMs` prop convention, not a config lever.
- The compact section shows the **latest unfiltered tail** (filters are overlay-only — the approved scope). This resolves the spec's Component-4 "filtered rows" wording in favor of the clarifying-question decision ("the compact section always just shows the latest tail").

---

### Task 1: `logReader.ts` — parse + tail + follow

**Files:**

- Create: `src/logReader.ts`
- Test: `tests/logReader.test.ts`

**Interfaces:**

- Produces:
  - `interface LogEntry { ts: string | null; level: "debug"|"info"|"warn"|"error"|null; ticket: string | null; msg: string; fields: Record<string, unknown>; raw: string }`
  - `interface LogReaderDeps { statFn?: (p: string) => { size: number }; openFn?: (p: string, flags: string) => number; readFn?: (fd: number, buf: Buffer, off: number, len: number, pos: number) => number; closeFn?: (fd: number) => void; existsFn?: (p: string) => boolean }`
  - `parseLogLine(raw: string): LogEntry` — tolerant; never throws.
  - `readTail(path: string, n: number, deps?: LogReaderDeps): LogEntry[]` — last `n` non-empty lines parsed; `[]` when the file is absent.
  - `interface LogTailer { poll(): LogEntry[]; rotated: boolean; reset(): void }`
  - `makeLogTailer(path: string, deps?: LogReaderDeps): LogTailer` — starts at EOF (only lines appended after creation are returned by `poll`).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/logReader.test.ts
import { describe, it, expect } from "vitest";
import { parseLogLine, readTail, makeLogTailer, type LogReaderDeps } from "../src/logReader.js";

const line = (o: Record<string, unknown>): string => JSON.stringify(o);

describe("parseLogLine", () => {
  it("parses a structured JSON line and strips canonical keys into fields", () => {
    const e = parseLogLine(
      line({
        ts: "2026-07-20T05:00:00.000Z",
        level: "warn",
        ticket: "junco-46",
        msg: "guard nudge",
        turn: 14,
      }),
    );
    expect(e).toEqual({
      ts: "2026-07-20T05:00:00.000Z",
      level: "warn",
      ticket: "junco-46",
      msg: "guard nudge",
      fields: { turn: 14 },
      raw: line({
        ts: "2026-07-20T05:00:00.000Z",
        level: "warn",
        ticket: "junco-46",
        msg: "guard nudge",
        turn: 14,
      }),
    });
  });

  it("normalizes ticket '-' to null and defaults a missing level to null", () => {
    const e = parseLogLine(line({ ts: "t", ticket: "-", msg: "x" }));
    expect(e.ticket).toBeNull();
    expect(e.level).toBeNull();
  });

  it("passes a non-JSON line through as raw at level null", () => {
    const e = parseLogLine("Segmentation fault (core dumped)");
    expect(e).toEqual({
      ts: null,
      level: null,
      ticket: null,
      msg: "Segmentation fault (core dumped)",
      fields: {},
      raw: "Segmentation fault (core dumped)",
    });
  });

  it("treats an unknown level string as null (not a fabricated level)", () => {
    expect(parseLogLine(line({ level: "trace", msg: "x" })).level).toBeNull();
  });
});

// A tiny in-memory file backing the fs deps: a mutable string with a byte view.
function fakeFs(initial = "") {
  let content = Buffer.from(initial, "utf8");
  const deps: LogReaderDeps = {
    existsFn: () => content !== null,
    statFn: () => ({ size: content.length }),
    openFn: () => 1,
    closeFn: () => undefined,
    readFn: (_fd, buf, off, len, pos) => {
      const slice = content.subarray(pos, pos + len);
      slice.copy(buf, off);
      return slice.length;
    },
  };
  return {
    deps,
    append: (s: string) => {
      content = Buffer.concat([content, Buffer.from(s, "utf8")]);
    },
    rotate: (s = "") => {
      content = Buffer.from(s, "utf8");
    }, // shrink → rotation
  };
}

describe("readTail", () => {
  it("returns the last n parsed entries, newest last", () => {
    const f = fakeFs([line({ msg: "a" }), line({ msg: "b" }), line({ msg: "c" }), ""].join("\n"));
    expect(readTail("/w.log", 2, f.deps).map((e) => e.msg)).toEqual(["b", "c"]);
  });
  it("returns [] when the file is absent", () => {
    const deps: LogReaderDeps = { existsFn: () => false };
    expect(readTail("/nope.log", 5, deps)).toEqual([]);
  });
});

describe("makeLogTailer", () => {
  it("returns only lines appended after creation (starts at EOF)", () => {
    const f = fakeFs(line({ msg: "old" }) + "\n");
    const t = makeLogTailer("/w.log", f.deps);
    expect(t.poll()).toEqual([]); // nothing new yet
    f.append(line({ msg: "new1" }) + "\n" + line({ msg: "new2" }) + "\n");
    expect(t.poll().map((e) => e.msg)).toEqual(["new1", "new2"]);
    expect(t.poll()).toEqual([]); // no change
  });

  it("carries a partial trailing line across polls", () => {
    const f = fakeFs("");
    const t = makeLogTailer("/w.log", f.deps);
    f.append(line({ msg: "half" }).slice(0, 5)); // no newline yet
    expect(t.poll()).toEqual([]); // partial line withheld
    f.append(line({ msg: "half" }).slice(5) + "\n");
    expect(t.poll().map((e) => e.msg)).toEqual(["half"]);
  });

  it("resets to head and flags rotated on size shrink", () => {
    const f = fakeFs(line({ msg: "a" }) + "\n");
    const t = makeLogTailer("/w.log", f.deps);
    t.poll();
    f.rotate(line({ msg: "fresh" }) + "\n"); // smaller file
    const out = t.poll();
    expect(t.rotated).toBe(true);
    expect(out.map((e) => e.msg)).toEqual(["fresh"]);
  });
});
```

- [ ] **Step 2: Run — fail.** `npx vitest run tests/logReader.test.ts > /tmp/t1 2>&1; echo "exit: $?"` → non-zero (module missing).

- [ ] **Step 3: Implement**

```ts
// src/logReader.ts
/**
 * Shared reader for the daemon's `<dataDir>/worker.log` (JSON-lines, written by
 * logging.ts's rotating sink). Owns the byte-offset follow mechanics extracted
 * from logsCmd: incremental read from a stored offset, rotation reset on size
 * shrink, partial-line carry. Deps-injectable over fs so it is unit-testable
 * with an in-memory file. `parseLogLine` is tolerant — a non-JSON line
 * (crash output) passes through as raw at level null; it never throws.
 */

import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";

export interface LogEntry {
  ts: string | null;
  level: "debug" | "info" | "warn" | "error" | null;
  ticket: string | null;
  msg: string;
  fields: Record<string, unknown>;
  raw: string;
}

export interface LogReaderDeps {
  statFn?: (p: string) => { size: number };
  openFn?: (p: string, flags: string) => number;
  readFn?: (fd: number, buf: Buffer, off: number, len: number, pos: number) => number;
  closeFn?: (fd: number) => void;
  existsFn?: (p: string) => boolean;
}

const LEVELS = new Set(["debug", "info", "warn", "error"]);

export function parseLogLine(raw: string): LogEntry {
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") obj = parsed as Record<string, unknown>;
  } catch {
    obj = null;
  }
  if (obj === null) {
    return { ts: null, level: null, ticket: null, msg: raw, fields: {}, raw };
  }
  const level =
    typeof obj.level === "string" && LEVELS.has(obj.level)
      ? (obj.level as LogEntry["level"])
      : null;
  const ticketRaw = typeof obj.ticket === "string" ? obj.ticket : null;
  const { ts, level: _l, ticket: _t, msg: _m, ...fields } = obj;
  return {
    ts: typeof ts === "string" ? ts : null,
    level,
    ticket: ticketRaw === "-" ? null : ticketRaw,
    msg: typeof obj.msg === "string" ? obj.msg : "",
    fields,
    raw,
  };
}

export function readTail(path: string, n: number, deps: LogReaderDeps = {}): LogEntry[] {
  const existsFn = deps.existsFn ?? existsSync;
  if (!existsFn(path)) return [];
  let content: string;
  try {
    // The reader has no injectable whole-file read seam; the fake-fs tests drive
    // readTail via statFn/readFn below when deps are supplied, and production
    // uses readFileSync. Prefer the seam when present.
    content =
      deps.statFn && deps.readFn && deps.openFn && deps.closeFn
        ? readViaSeam(path, deps)
        : readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = content.split("\n").filter((l) => l !== "");
  return lines.slice(-n).map(parseLogLine);
}

/** Read the whole file through the injected fs seam (tests). */
function readViaSeam(
  path: string,
  deps: Required<Pick<LogReaderDeps, "statFn" | "openFn" | "readFn" | "closeFn">>,
): string {
  const size = deps.statFn(path).size;
  const fd = deps.openFn(path, "r");
  try {
    const buf = Buffer.alloc(size);
    deps.readFn(fd, buf, 0, size, 0);
    return buf.toString("utf8");
  } finally {
    deps.closeFn(fd);
  }
}

export interface LogTailer {
  poll(): LogEntry[];
  rotated: boolean;
  reset(): void;
}

export function makeLogTailer(path: string, deps: LogReaderDeps = {}): LogTailer {
  const statFn = deps.statFn ?? ((p: string) => ({ size: statSync(p).size }));
  const openFn = deps.openFn ?? ((p: string) => openSync(p, "r"));
  const readFn = deps.readFn ?? ((fd, buf, off, len, pos) => readSync(fd, buf, off, len, pos));
  const closeFn = deps.closeFn ?? closeSync;

  let pos = sizeOrZero(); // start at EOF: only new lines follow
  let carry = "";
  const tailer: LogTailer = {
    rotated: false,
    reset(): void {
      pos = 0;
      carry = "";
    },
    poll(): LogEntry[] {
      this.rotated = false;
      let size: number;
      try {
        size = statFn(path).size;
      } catch {
        return []; // vanished mid-poll — next tick re-stats
      }
      if (size < pos) {
        pos = 0; // rotation: new file is smaller
        carry = "";
        this.rotated = true;
      }
      if (size <= pos) return [];
      const fd = openFn(path, "r");
      try {
        const buf = Buffer.alloc(size - pos);
        readFn(fd, buf, 0, buf.length, pos);
        pos = size;
        const chunk = carry + buf.toString("utf8");
        const parts = chunk.split("\n");
        carry = parts.pop() ?? "";
        return parts.filter((l) => l !== "").map(parseLogLine);
      } finally {
        closeFn(fd);
      }
    },
  };
  return tailer;

  function sizeOrZero(): number {
    try {
      return statFn(path).size;
    } catch {
      return 0;
    }
  }
}
```

- [ ] **Step 4: Run — pass.** Same command → 0.
- [ ] **Step 5: Commit.** `git add src/logReader.ts tests/logReader.test.ts && git commit -m "feat: shared worker.log reader — parse, tail, incremental follow"`

---

### Task 2: refactor `logsCmd` onto the shared reader

**Files:**

- Modify: `src/logsCmd.ts`
- Test: `tests/logsCmd.test.ts` (existing suite is the regression net — keep it green; read it first)

**Interfaces:**

- Consumes: `readTail`, `makeLogTailer` (Task 1). The follow loop's per-tick body becomes `tailer.poll()` rendered via the existing `render(entry.raw, json)`.

- [ ] **Step 1: Confirm the current behavior is captured.** Read `tests/logsCmd.test.ts`. If it lacks a rotation-during-follow case, add one (fake `pollMs`, `signal`, and a temp file that shrinks mid-follow → the tail resumes from the new head). This is the regression guard for the refactor.

- [ ] **Step 2: Run — green now (baseline).** `npx vitest run tests/logsCmd.test.ts > /tmp/t2 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 3: Refactor.** In `src/logsCmd.ts`:
  - Initial tail: replace the `readFileSync(path,...).split(...)` block with `readTail(path, opts.lines ?? 100)` and `for (const e of tail) print(render(e.raw, json));`.
  - Follow loop: replace the inline `statSync`/`openSync`/`readSync`/carry block inside the `setInterval` with a `const tailer = makeLogTailer(path);` created just before the interval, and a body of `for (const e of tailer.poll()) print(render(e.raw, json));`. Keep the same `pollMs`, `signal`/`SIGINT` teardown, and the no-file early return. Delete the now-unused `pos`/`carry` locals and the direct fs imports that are no longer referenced.
  - `render` is unchanged (`json ? raw+"\n" : formatHumanLine(JSON.parse(raw))+"\n"`), so `--json` and human output stay byte-identical.

- [ ] **Step 4: Run — pass.** `npx vitest run tests/logsCmd.test.ts > /tmp/t2 2>&1; echo "exit: $?"` → 0, and `npx tsc --noEmit -p tsconfig.eslint.json` shows no new errors.
- [ ] **Step 5: Commit.** `git commit -m "refactor: logsCmd follows via the shared logReader (one tail implementation)"`

---

### Task 3: `logFilter.ts` — pure filtering + level order

**Files:**

- Create: `src/tui/logFilter.ts`
- Test: `tests/logFilter.test.ts`

**Interfaces:**

- Consumes: `LogEntry` (Task 1).
- Produces:
  - `type Level = "debug" | "info" | "warn" | "error"`
  - `const LEVEL_ORDER: Level[] = ["debug", "info", "warn", "error"]`
  - `levelRank(l: LogEntry["level"]): number` — rank 0-3; a `null` level ranks as `info` (1) so unstructured lines survive an info threshold but are hidden at warn+.
  - `cycleLevel(l: Level): Level` — debug→info→warn→error→debug.
  - `interface LogFilters { minLevel: Level; ticket: string | null; search: string }`
  - `filterEntries(entries: LogEntry[], f: LogFilters): LogEntry[]` — keep entries with `levelRank ≥ rank(minLevel)`, matching `ticket` when set, and (case-insensitive) containing `search` in `msg`/`ticket`/`JSON.stringify(fields)` when non-empty.
  - `distinctTickets(entries: LogEntry[]): string[]` — sorted unique non-null tickets present.

- [ ] **Step 1: Failing tests**

```ts
// tests/logFilter.test.ts
import { describe, it, expect } from "vitest";
import { filterEntries, distinctTickets, cycleLevel, levelRank } from "../src/tui/logFilter.js";
import type { LogEntry } from "../src/logReader.js";

const e = (o: Partial<LogEntry>): LogEntry => ({
  ts: null,
  level: "info",
  ticket: null,
  msg: "",
  fields: {},
  raw: "",
  ...o,
});

describe("levelRank / cycleLevel", () => {
  it("ranks null as info and orders debug<info<warn<error", () => {
    expect(levelRank(null)).toBe(levelRank("info"));
    expect(levelRank("debug")).toBeLessThan(levelRank("warn"));
    expect(levelRank("error")).toBeGreaterThan(levelRank("warn"));
  });
  it("cycles debug→info→warn→error→debug", () => {
    expect(["debug", "info", "warn", "error"].map(cycleLevel)).toEqual([
      "info",
      "warn",
      "error",
      "debug",
    ]);
  });
});

describe("filterEntries", () => {
  const es = [
    e({ level: "debug", msg: "d" }),
    e({ level: "info", ticket: "junco-46", msg: "claimed" }),
    e({ level: "warn", ticket: "junco-46", msg: "guard nudge", fields: { action: "nudge" } }),
    e({ level: "error", ticket: "junco-47", msg: "push failed" }),
    e({ level: null, msg: "raw crash" }),
  ];
  it("applies a level threshold (null counts as info)", () => {
    expect(
      filterEntries(es, { minLevel: "warn", ticket: null, search: "" }).map((x) => x.msg),
    ).toEqual(["guard nudge", "push failed"]);
  });
  it("filters by ticket", () => {
    expect(
      filterEntries(es, { minLevel: "debug", ticket: "junco-46", search: "" }).map((x) => x.msg),
    ).toEqual(["claimed", "guard nudge"]);
  });
  it("substring-searches msg, ticket, and fields case-insensitively", () => {
    expect(
      filterEntries(es, { minLevel: "debug", ticket: null, search: "NUDGE" }).map((x) => x.msg),
    ).toEqual(["guard nudge"]);
    expect(
      filterEntries(es, { minLevel: "debug", ticket: null, search: "junco-47" }).map((x) => x.msg),
    ).toEqual(["push failed"]);
  });
});

describe("distinctTickets", () => {
  it("returns sorted unique non-null tickets", () => {
    expect(
      distinctTickets([
        e({ ticket: "b" }),
        e({ ticket: null }),
        e({ ticket: "a" }),
        e({ ticket: "b" }),
      ]),
    ).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement**

```ts
// src/tui/logFilter.ts
/** Pure filtering helpers over LogEntry[] for the TUI log view. No I/O. */

import type { LogEntry } from "../logReader.js";

export type Level = "debug" | "info" | "warn" | "error";
export const LEVEL_ORDER: Level[] = ["debug", "info", "warn", "error"];

/** Rank for the level threshold; a null (unstructured) line ranks as info so it
 * survives info but hides at warn+. */
export function levelRank(l: LogEntry["level"]): number {
  return l === null ? 1 : LEVEL_ORDER.indexOf(l);
}

export function cycleLevel(l: Level): Level {
  return LEVEL_ORDER[(LEVEL_ORDER.indexOf(l) + 1) % LEVEL_ORDER.length];
}

export interface LogFilters {
  minLevel: Level;
  ticket: string | null;
  search: string;
}

export function filterEntries(entries: LogEntry[], f: LogFilters): LogEntry[] {
  const min = levelRank(f.minLevel);
  const needle = f.search.trim().toLowerCase();
  return entries.filter((e) => {
    if (levelRank(e.level) < min) return false;
    if (f.ticket !== null && e.ticket !== f.ticket) return false;
    if (needle !== "") {
      const hay = `${e.msg} ${e.ticket ?? ""} ${JSON.stringify(e.fields)}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

export function distinctTickets(entries: LogEntry[]): string[] {
  const s = new Set<string>();
  for (const e of entries) if (e.ticket !== null) s.add(e.ticket);
  return [...s].sort();
}
```

- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(tui): pure log-filter helpers (level/ticket/search)"`

---

### Task 4: `useLogTail` hook — bounded buffer + visibility-gated poll

**Files:**

- Create: `src/tui/useLogTail.ts`
- Test: `tests/useLogTail.test.tsx`

**Interfaces:**

- Consumes: `LogEntry`, `LogReaderDeps`, `readTail`, `makeLogTailer` (Task 1).
- Produces:
  - `const LOG_BUFFER_CAP = 2000`
  - `function appendBounded(buf: LogEntry[], add: LogEntry[], cap: number): LogEntry[]` — `[...buf, ...add].slice(-cap)` (pure; exported for test).
  - `const ROTATED_MARKER: LogEntry` — `{ ts: null, level: null, ticket: null, msg: "─ log rotated ─", fields: {}, raw: "" }`.
  - `interface UseLogTailOpts { pollMs?: number; seedN?: number; cap?: number; readerDeps?: LogReaderDeps }`
  - `function useLogTail(path: string, active: boolean, opts?: UseLogTailOpts): LogEntry[]` — while `active`, seeds via `readTail(path, seedN)` then polls `makeLogTailer(path).poll()` every `pollMs`, appending into a bounded buffer (a `ROTATED_MARKER` row is inserted on a rotation poll). When `active` goes false (or unmount) it clears the interval and resets the buffer to `[]`, so re-entry re-seeds fresh.

- [ ] **Step 1: Failing tests.** Use ink-testing-library with a tiny probe component that renders the entry count, and inject `readerDeps` backed by an in-memory file (reuse the `fakeFs` shape from Task 1's test — copy it into this file). Loop-until-condition; never a fixed tick.

```ts
// tests/useLogTail.test.tsx — sketch; fill in the fakeFs helper from Task 1
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useLogTail, appendBounded, LOG_BUFFER_CAP } from "../src/tui/useLogTail.js";
import type { LogEntry } from "../src/logReader.js";

const entry = (msg: string): LogEntry => ({
  ts: null,
  level: "info",
  ticket: null,
  msg,
  fields: {},
  raw: "",
});

describe("appendBounded", () => {
  it("appends and caps to the last `cap` entries", () => {
    const out = appendBounded([entry("a"), entry("b")], [entry("c")], 2);
    expect(out.map((e) => e.msg)).toEqual(["b", "c"]);
  });
  it("cap default is 2000", () => expect(LOG_BUFFER_CAP).toBe(2000));
});

// Probe renders the live count; assert it grows as the fake file appends, and
// that flipping `active` false clears it. Poll gating: with active=false, the
// injected readFn/statFn are never called (spy counters stay 0).
```

Enumerated behaviors to cover (one probe test each):

1. `active=true` seeds the last `seedN` lines immediately (count reflects the seeded tail after a bounded wait).
2. New appends to the fake file appear on the next poll (count grows).
3. `active=false` from the start → the injected `statFn`/`readFn` are never called (assert spy counts 0) and the returned array is empty.
4. Flipping `active` true→false clears the buffer to `[]`; flipping back re-seeds.
5. A rotation (fake file shrinks) inserts one `ROTATED_MARKER` row before the fresh lines.

- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement**

```ts
// src/tui/useLogTail.ts
/**
 * Live tail of worker.log into a bounded in-memory buffer, gated on `active`
 * (the TUI passes true only while the logs section or overlay is on screen —
 * so nothing reads the disk when logs aren't being viewed). Seeds the recent
 * tail on activation, polls for deltas, resets on deactivation.
 */

import { useEffect, useRef, useState } from "react";
import {
  makeLogTailer,
  readTail,
  type LogEntry,
  type LogReaderDeps,
  type LogTailer,
} from "../logReader.js";

export const LOG_BUFFER_CAP = 2000;

export const ROTATED_MARKER: LogEntry = {
  ts: null,
  level: null,
  ticket: null,
  msg: "─ log rotated ─",
  fields: {},
  raw: "",
};

export function appendBounded(buf: LogEntry[], add: LogEntry[], cap: number): LogEntry[] {
  if (add.length === 0) return buf;
  return [...buf, ...add].slice(-cap);
}

export interface UseLogTailOpts {
  pollMs?: number;
  seedN?: number;
  cap?: number;
  readerDeps?: LogReaderDeps;
}

export function useLogTail(path: string, active: boolean, opts: UseLogTailOpts = {}): LogEntry[] {
  const pollMs = opts.pollMs ?? 500;
  const seedN = opts.seedN ?? 200;
  const cap = opts.cap ?? LOG_BUFFER_CAP;
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const tailerRef = useRef<LogTailer | null>(null);

  useEffect(() => {
    if (!active) {
      setEntries([]);
      tailerRef.current = null;
      return;
    }
    setEntries(readTail(path, seedN, opts.readerDeps));
    const tailer = makeLogTailer(path, opts.readerDeps);
    tailerRef.current = tailer;
    const id = setInterval(() => {
      const fresh = tailer.poll();
      const add = tailer.rotated ? [ROTATED_MARKER, ...fresh] : fresh;
      if (add.length > 0) setEntries((buf) => appendBounded(buf, add, cap));
    }, pollMs);
    return () => {
      clearInterval(id);
      tailerRef.current = null;
    };
    // opts.readerDeps identity is stable per test; path/active/pollMs drive it.
  }, [path, active, pollMs, seedN, cap, opts.readerDeps]);

  return entries;
}
```

- [ ] **Step 4: Run — pass.** `npx vitest run tests/useLogTail.test.tsx > /tmp/t4 2>&1; echo "exit: $?"` → 0.
- [ ] **Step 5: Commit.** `git commit -m "feat(tui): useLogTail — visibility-gated bounded worker.log buffer"`

---

### Task 5: `LogView.tsx` — compact section + full-screen overlay renderer

**Files:**

- Create: `src/tui/components/LogView.tsx`
- Test: `tests/logView.test.tsx`

**Interfaces:**

- Consumes: `LogEntry` (Task 1); `filterEntries`, `distinctTickets`, `LogFilters`, `Level` (Task 3); `clampScroll`, `maxScroll` from `../window.js`; `theme` from `../theme.js`.
- Produces: `function LogView(props): React.JSX.Element` with

```ts
interface LogViewProps {
  variant: "section" | "full";
  entries: LogEntry[]; // the raw buffer (unfiltered)
  height: number;
  focused: boolean;
  hasFile: boolean; // false → "no log file yet" placeholder
  // full-variant only:
  filters?: LogFilters;
  follow?: boolean;
  scroll?: number; // top offset when paused
  onScrollMax?: (max: number) => void;
  onExpand?: () => void; // section: click to open overlay
  onWheel?: (dir: 1 | -1) => void;
}
```

- **Row renderer** (shared): `HH:MM:SS` (dim, from `ts`; blank when null) · `LEVEL` padded-5 in its color (debug dim, info cyan `theme.info`, warn `theme.warn`, error `theme.error`, null → dim `·····`) · `[ticket]` dim when present · `msg` · compact `fields` dim (JSON, omitted when empty), wrapped `truncate-end`.
- **section:** last `k = max(1, height - 2)` entries of `entries` **unfiltered**, always the tail; a `ROTATED_MARKER` renders as a centered dim rule. Header `logs  ●` (follow dot) + count; the pane is a `ClickableBox` calling `onExpand` and forwarding `onWheel`. No `no-file` rows → the `hasFile === false` placeholder.
- **full:** `rows = filterEntries(entries, filters)`; `visible = max(1, height - 4)`; `start = follow ? maxScroll(rows.length, visible) : clampScroll(scroll, rows.length, visible)`; `onScrollMax?.(maxScroll(rows.length, visible))`. Header shows filter chips (`level ≥ warn` when `minLevel !== "debug"`, `#<ticket>` when set, `"<search>"` when set) + a follow indicator (`● following` / `⏸ paused`). Empty `rows` under active filters → `no lines match` (vs `hasFile===false` → the daemon-not-started placeholder). Footer hint line lists the keys.

- [ ] **Step 1: Failing tests** (ink-testing-library; loop-until-condition). Cover:
  1. section renders the last `k` entries unfiltered, newest at the bottom, with the follow dot + count.
  2. Level colors: a warn row carries `theme.warn`, error `theme.error` (assert via the frame text + that the level label is present; color assertions per the suite's existing approach).
  3. `ROTATED_MARKER` renders as the rule row.
  4. full variant with `filters={minLevel:"warn"}` shows only warn+; the chip `level ≥ warn` is present.
  5. full variant `follow=true` shows the bottom `visible` rows; `follow=false, scroll=0` shows the top rows (assert first vs last visible line differs).
  6. `hasFile=false` → the "daemon writes it once started" placeholder in both variants.
  7. full variant with a filter that matches nothing → `no lines match`.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** per the interface above (reuse `QueueView`/`DaemonSection` structure for the bordered box, `clampScroll`/`maxScroll` window math, and `ClickableBox` for mouse). Keep it one file, one exported component, a private `LogRow` helper.
- [ ] **Step 4: Run — pass.** `npx vitest run tests/logView.test.tsx > /tmp/t5 2>&1; echo "exit: $?"` → 0.
- [ ] **Step 5: Commit.** `git commit -m "feat(tui): LogView — compact section + filtered full-screen log renderer"`

---

### Task 6: wire the compact logs section (LocalSection + LocalDashboard + App)

**Files:**

- Modify: `src/tui/localSnapshot.ts` (`LocalSection` union), `src/tui/components/LocalDashboard.tsx` (`SECTIONS`, `sectionBadge`, body switch), `src/tui/App.tsx` (hook, cursor record, `LOCAL_SECTIONS`, render, path, mouse expand stub)
- Test: extend the LOCAL dashboard/app suite (find it: `grep -rln "LocalDashboard\|LOCAL_SECTIONS\|localSection" tests/`) + fixture sweep for the widened union.

**Interfaces:**

- Consumes: `useLogTail` (Task 4), `LogView` (Task 5).
- Produces: `LocalSection` gains `"logs"`. `LogView variant="section"` is rendered for it. Task 7 adds the overlay this task's `onExpand` opens (here it may be a no-op/stub wired to a `setLogOverlay(true)` added in Task 7 — to keep Task 6 self-contained, add the `logOverlay` state boolean here defaulting false and the setter, but only the section + its open handler; the overlay render + keys land in Task 7).

- [ ] **Step 1: Failing tests.** In the LOCAL app/dashboard suite:
  1. `LOCAL_SECTIONS`/rail includes `logs` after `daemon` (navigable with `j`/`G`); the rail row renders `logs`.
  2. Selecting the `logs` section renders a `LogView` (assert a section-only string, e.g. the `logs` header / follow dot) sourced from an injected `readerDeps`/fake log file (thread a `logReaderDeps`-style prop or a `logsPollMs` + a temp file — mirror how the suite injects `localCheapFn`).
  3. The logs poll is **gated**: on any non-logs section (and in GitHub mode) the injected log `statFn`/`readFn` are never called (spy counts 0); on the logs section they are.
  4. `sectionBadge("logs", …)` returns `""` (assert). The live/follow indicator is the `●` dot in the `LogView` **header**, not a rail badge — see the deviation note below.

- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement.**
  - `localSnapshot.ts`: `export type LocalSection = "queue" | "outbox" | "repos" | "worktrees" | "daemon" | "logs";`
  - `LocalDashboard.tsx`: `SECTIONS` array append `"logs"`; `sectionBadge` switch add `case "logs": return "";` (exhaustiveness now satisfied — **deviation from spec Component 5**: the spec put a live `●` dot on the rail badge; a rail dot is redundant with the `▌` cursor (the logs poll is active exactly when the section is selected and the rail is visible), so the live/follow indicator lives in the `LogView` header instead, where following-vs-paused is genuinely informative. Flagged here for the reviewer.); body switch add a `logs` branch rendering `<LogView variant="section" entries={logEntries ?? []} height={h} focused={bodyFocused} hasFile={logHasFile ?? true} onExpand={onLogExpand} onWheel={onDaemonWheel} />` — add the new props (`logEntries?`, `logHasFile?`, `onLogExpand?`) to `LocalDashboard`'s props (all optional/additive).
  - `App.tsx`:
    - Cursor record literal gains `logs: 0`; `LOCAL_SECTIONS` gains `"logs"`.
    - `localRowsFor`: add `case "logs": return [];` (viewport, no selectable rows — like daemon).
    - Log path: `const logPath = useMemo(() => join(cfg.dataDir, "worker.log"), [cfg.dataDir]);` (import `join`; `cfg` is available where other dashboard paths resolve).
    - `const logActive = uiMode === "local" && (localSection === "logs" || logOverlay);` and `const logEntries = useLogTail(logPath, logActive, { pollMs: props.logsPollMs, readerDeps: props.logReaderDeps });` — add optional props `logsPollMs?: number` and `logReaderDeps?: LogReaderDeps` to the App props (test seam; production omits them). `const logHasFile = logEntries.length > 0;` — no render-time fs call; an empty or absent file both show the placeholder until the first line arrives (a running daemon fills within one poll). Acceptable for v1.
    - `const [logOverlay, setLogOverlay] = useState(false);` and `onLogExpand = () => setLogOverlay(true);` passed to `LocalDashboard`.
    - Render: pass `logEntries`, `logHasFile`, `onLogExpand` to `<LocalDashboard …>`.
  - Typecheck sweep: the widened union forces the `Record<LocalSection, number>` literal + every exhaustive `switch` (sectionBadge, localRowsFor, and any in `queueSnapshot`/`makeLocalCheapFn` — `opts.section` only compares to `"queue"`, no exhaustiveness there) to handle `logs`. Fix all in this commit.
- [ ] **Step 4: Run — pass.** Section suite + `npx tsc --noEmit -p tsconfig.eslint.json` (no new errors) + full suite once. Never pipe vitest into filters.
- [ ] **Step 5: Commit.** `git commit -m "feat(tui): compact logs section in the LOCAL rail"`

---

### Task 7: full-screen log overlay (filters, follow, keys, mouse)

**Files:**

- Modify: `src/tui/App.tsx` (overlay state, `handleLocalInput` branch, render, mouse, `scrollKey`), `src/tui/useScroll.ts` (add `toEnd()`)
- Test: `tests/useScroll.test.ts` (extend for `toEnd`), a new `tests/tuiLogOverlay.test.tsx`

**Interfaces:**

- Consumes: `LogView variant="full"` (Task 5), `filterEntries`/`cycleLevel`/`distinctTickets`/`LogFilters`/`Level` (Task 3), the `logOverlay` state (Task 6).
- Produces: `ScrollHandle` gains `toEnd(): void` (sets the offset to the last-reported max).

- [ ] **Step 1: Failing tests.**
  - `useScroll`: `toEnd()` sets `scroll` to the max last reported via `onScrollMax`, clamped; after a key change (reset) it is 0 until the surface re-reports.
  - `tuiLogOverlay`: from the logs section, `Enter` (and a click on the section pane) opens the overlay (assert an overlay-only string, e.g. the footer key hints / `paused|following`); `esc` closes it back to the section. `l` cycles the level chip (`level ≥ info` → `warn` → …). `t` cycles the ticket chip through the buffer's tickets and back to all. `/` then typed chars then `Enter` sets the search chip; `esc` in search clears it. `f` toggles follow; `[`/up while following pauses (chip shows `paused`) and shows a higher row; `G` resumes follow (chip `following`). The overlay owns input: pressing `t` inside does NOT open the GitHub `t` queue view (still in LOCAL mode, overlay open).
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement.**
  - `useScroll.ts`: add `const toEnd = useCallback(() => setScroll(maxRef.current), []);` and return it; document it as "jump to the bottom (last reported max)".
  - `App.tsx` state: `logFollow` (default true), `logFilters` (`{ minLevel: "info", ticket: null, search: "" }`), `logSearchMode` (bool). `scrollKey` useMemo: `if (uiMode === "local" && logOverlay) return "logOverlay";` ahead of the `local:<section>` branch.
  - `handleLocalInput`: at the TOP (right after the help/confirm modal guards, before the body/rail split), add `if (logOverlay) { …; return; }` so the overlay owns input while open:
    - search mode: printable chars append to `logFilters.search`; Backspace pops; `Enter` exits search mode (keeps the term); `Esc` clears the term + exits search mode.
    - else: `esc`/`q` → `setLogOverlay(false)`; `f` → toggle follow (on pause: `toEnd()`); `l` → `setLogFilters(f => ({...f, minLevel: cycleLevel(f.minLevel)}))`; `t` → cycle `logFilters.ticket` through `[null, ...distinctTickets(logEntries)]`; `/` → `setLogSearchMode(true)`; `G`/End → `setLogFollow(true)`; `[`/up → `if (logFollow) { setLogFollow(false); toEnd(); } scrollBy(-1)`; `]`/down → `scrollBy(1)`.
  - Render: when `uiMode === "local" && logOverlay`, render `<LogView variant="full" entries={logEntries} filters={logFilters} follow={logFollow} scroll={scroll} height={listHeight} focused hasFile={logHasFile} onScrollMax={onScrollMax} onWheel={(d) => { if (logFollow && d < 0) { setLogFollow(false); toEnd(); } scrollBy(d); }} />` INSTEAD of `<LocalDashboard>` (add this branch just before the `uiMode === "local"` LocalDashboard branch at App.tsx:2489).
  - Mouse: `onLogExpand` already opens it (Task 6); wheel handled above. Those are the actionable surfaces (expand + scroll) and both have mouse parity. The filter **chips are display-only** (state indicators, not buttons) — filters cycle via keys, so no chip click handler is needed and parity is not owed for them. `esc`-to-close is keyboard-only, matching the existing `t` queue overlay precedent (App.tsx:1648).
- [ ] **Step 4: Run — pass.** `useScroll` + `tuiLogOverlay` + full suite + `npm run lint` + typecheck (no new errors).
- [ ] **Step 5: Commit.** `git commit -m "feat(tui): full-screen log overlay — filters, follow, scrollback"`

---

### Task 8: docs truth sweep + full gate

**Files:**

- Modify: `ARCHITECTURE.md`, `CHANGELOG.md` (Unreleased → Added), `docs/dashboard.md`; check `grep -rl "junco logs" docs/` for a logs doc to cross-reference.

- [ ] **Step 1: Sweep.**
  - ARCHITECTURE.md: add `logReader.ts`, `tui/logFilter.ts`, `tui/useLogTail.ts`, `tui/components/LogView.tsx` to the module map; note `logsCmd` now follows via `logReader`; note the LOCAL `logs` section + overlay read `worker.log` (separate process → file, not a live stream).
  - CHANGELOG.md Unreleased → Added: live daemon-log view in the TUI (compact LOCAL section + full-screen overlay with level/ticket/text filters, follow + scrollback); `junco logs` and the TUI now share one tailer. No behavior-change entries (additive).
  - docs/dashboard.md: document the `logs` section and the overlay keys (`f`/`l`/`t`/`/`/`G`/`esc`, Enter/click to expand).
- [ ] **Step 2: Full gate.** `npm run lint && npm run format:check && npm run typecheck && npm run build && npx vitest run > /tmp/gate 2>&1; echo "exit: $?"` → 0 (capture vitest exit explicitly).
- [ ] **Step 3: Commit.** `git commit -m "docs: TUI live log view — architecture, changelog, dashboard docs"`
