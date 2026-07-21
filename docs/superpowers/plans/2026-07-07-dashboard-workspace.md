# Dashboard Workspace (UX Facelift) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `junco dashboard` as a fullscreen, responsive, themed workspace — alt-screen rendering, three-pane master-detail on wide terminals, full-row selection, one accent color, numbered panes, `/` filter, context-first help.

**Architecture:** Pure foundation modules (`theme`, `layout`, `window`, `useTerminalSize`) land first; new components (`Chrome`, `Rail`, `IssueList`, `Preview`, `Modal`, `Workspace`) land unwired with their own tests; one switch task rewires `App.tsx` and migrates the existing TUI tests atomically; docs close it out. Suite green at every commit.

**Tech Stack:** TypeScript strict/ESM, Ink 7.1.0 + React 19.2.7 (already installed — NO new dependencies), vitest + ink-testing-library.

**Spec:** `docs/superpowers/specs/2026-07-07-dashboard-workspace-design.md`

## Global Constraints

- Branch `feat/dashboard-workspace` off `feat/dashboard-queue` (stacked — this plan consumes queueSnapshot/queueFmt/QueueView, which are not on main yet). Conventional commits, suite green at every commit. **No AI attribution** in any commit (no `Co-Authored-By: Claude`, no "Generated with"); amend it away if auto-appended.
- **Zero new dependencies, zero new config keys.** Everything uses native Ink 7.1.0 (`alternateScreen`, `useWindowSize`, `Box backgroundColor`).
- **One accent** — `#eb6f92` — used ONLY for: focused-pane border+title, selection bar glyph `▌`, brand chip, modal border/title, active filter chip, footer hotkeys. Lifecycle state colors (`state.ts stateMeta`) are unchanged.
- Full-row selection = `Box backgroundColor` (a `Text backgroundColor` covers only the character run — never use it for row bars).
- The rendered frame height must NEVER exceed terminal rows: every list windows through `windowSlice`; the chrome reserves exactly 3 rows (header, toast, footer).
- Existing action keys keep their meanings: `d D a R o w x r : t ? q` and `[`/`]` for scroll. New keys: `1/2/3` panes, `/` filter, `g/G` first/last, `enter` = focus preview (wide) / open detail (medium).
- `q` quits from main view only — unchanged.
- Ink test discipline: bounded until-loops, never a single fixed tick (CLAUDE.md). Vitest exit-code trap: capture explicitly (`npx vitest run > /tmp/out 2>&1; echo "exit: $?"`), never pipe through a filter.
- `npx prettier --write` touched files before every commit.
- Live-runtime rule: never touch `config.toml`/`tickets/`/`worktrees/`; component tests never hit network (fake clients/snapshots as in existing tui tests).

---

### Task 1: Foundation modules — theme, window, layout, useTerminalSize

**Files:**

- Create: `src/tui/theme.ts`, `src/tui/window.ts`, `src/tui/layout.ts`, `src/tui/useTerminalSize.ts`
- Test: `tests/tuiFoundation.test.ts`

**Interfaces:**

- Consumes: Ink's `useWindowSize` (verify the export exists in `node_modules/ink/build/index.d.ts` before writing code; it is documented in the installed readme).
- Produces (every later task relies on these exact names):
  - `theme` const: `{ accent: "#eb6f92"; selectionBg: "#2a2e3a"; border: "gray"; success: "green"; warn: "yellow"; error: "red"; info: "cyan" }`
  - `type ToastKind = "info" | "success" | "error"` and `toastColor(k: ToastKind): string`
  - `windowSlice(total: number, height: number, cursor: number, prevStart: number): { start: number; end: number }`
  - `type LayoutMode = "wide" | "medium" | "tooSmall"`, `interface Layout { mode: LayoutMode; railWidth: number; previewWidth: number; bodyRows: number }`, `computeLayout(columns: number, rows: number): Layout`, consts `MIN_COLS=60 MIN_ROWS=14 WIDE_COLS=110 RAIL_WIDTH=26 PREVIEW_CAP=60 CHROME_ROWS=3`
  - `interface TerminalSize { columns: number; rows: number }`, `useTerminalSize(override?: TerminalSize): TerminalSize`

- [ ] **Step 1: Write the failing tests** — create `tests/tuiFoundation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { theme, toastColor } from "../src/tui/theme.js";
import { windowSlice } from "../src/tui/window.js";
import { computeLayout, WIDE_COLS, MIN_COLS, MIN_ROWS, CHROME_ROWS } from "../src/tui/layout.js";

describe("theme", () => {
  it("exposes the slate & rose tokens", () => {
    expect(theme.accent).toBe("#eb6f92");
    expect(theme.selectionBg).toBe("#2a2e3a");
    expect(toastColor("error")).toBe(theme.error);
    expect(toastColor("success")).toBe(theme.success);
    expect(toastColor("info")).toBe(theme.info);
  });
});

describe("windowSlice (follow-the-cursor)", () => {
  it("shows everything when it fits", () => {
    expect(windowSlice(5, 10, 2, 0)).toEqual({ start: 0, end: 5 });
  });
  it("keeps the window still while the cursor moves inside it", () => {
    expect(windowSlice(20, 5, 6, 4)).toEqual({ start: 4, end: 9 });
  });
  it("follows the cursor down minimally", () => {
    expect(windowSlice(20, 5, 9, 4)).toEqual({ start: 5, end: 10 });
  });
  it("follows the cursor up minimally", () => {
    expect(windowSlice(20, 5, 3, 4)).toEqual({ start: 3, end: 8 });
  });
  it("clamps a stale prevStart when the list shrinks", () => {
    expect(windowSlice(6, 5, 5, 10)).toEqual({ start: 1, end: 6 });
  });
  it("degenerate inputs return empty", () => {
    expect(windowSlice(0, 5, 0, 0)).toEqual({ start: 0, end: 0 });
    expect(windowSlice(5, 0, 0, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("computeLayout", () => {
  it("wide at ≥110 cols: rail 26, preview 40% capped 60", () => {
    const l = computeLayout(120, 30);
    expect(l).toEqual({
      mode: "wide",
      railWidth: 26,
      previewWidth: 48,
      bodyRows: 30 - CHROME_ROWS,
    });
    expect(computeLayout(200, 30).previewWidth).toBe(60); // cap
  });
  it("medium between 60 and 109 cols", () => {
    expect(computeLayout(100, 30)).toEqual({
      mode: "medium",
      railWidth: 26,
      previewWidth: 0,
      bodyRows: 27,
    });
  });
  it("tooSmall under 60 cols or 14 rows", () => {
    expect(computeLayout(MIN_COLS - 1, 30).mode).toBe("tooSmall");
    expect(computeLayout(120, MIN_ROWS - 1).mode).toBe("tooSmall");
  });
  it("boundary values are exact", () => {
    expect(computeLayout(WIDE_COLS, 14).mode).toBe("wide");
    expect(computeLayout(WIDE_COLS - 1, 14).mode).toBe("medium");
    expect(computeLayout(60, 14).mode).toBe("medium");
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/tuiFoundation.test.ts > /tmp/t1 2>&1; echo "exit: $?"; tail -5 /tmp/t1` → FAIL (modules missing).

- [ ] **Step 3: Implement.** First confirm the hook export: `grep -n "useWindowSize" node_modules/ink/build/index.d.ts` — expect a named export. Then:

`src/tui/theme.ts`:

```ts
/** "Slate & rose" — the junco palette (slate bird, pink bill). ONE accent;
 * structure tones are slate/gray; status colors stay semantic (state.ts).
 * Hex passes through chalk, which downsamples on 256/16-color terminals and
 * honors NO_COLOR (the ▌ selection glyph keeps selection legible colorless). */
export const theme = {
  accent: "#eb6f92",
  selectionBg: "#2a2e3a",
  border: "gray",
  success: "green",
  warn: "yellow",
  error: "red",
  info: "cyan",
} as const;

export type ToastKind = "info" | "success" | "error";

export function toastColor(k: ToastKind): string {
  return k === "error" ? theme.error : k === "success" ? theme.success : theme.info;
}
```

`src/tui/window.ts`:

```ts
/** Slice `total` rows to a `height` window that follows `cursor` with minimal
 * movement: the window only moves when the cursor would leave it, and a stale
 * prevStart (list shrank) clamps instead of overflowing. */
export function windowSlice(
  total: number,
  height: number,
  cursor: number,
  prevStart: number,
): { start: number; end: number } {
  if (height <= 0 || total <= 0) return { start: 0, end: 0 };
  const h = Math.min(height, total);
  let start = Math.min(Math.max(prevStart, 0), total - h);
  const c = Math.min(Math.max(cursor, 0), total - 1);
  if (c < start) start = c;
  else if (c >= start + h) start = c - h + 1;
  return { start, end: start + h };
}
```

`src/tui/layout.ts`:

```ts
/** Pure breakpoint math for the fullscreen workspace. The chrome is exactly
 * 3 rows (header, toast, footer) — bodyRows is what panes may fill; the total
 * frame must never exceed terminal rows (Ink redraws duplicate otherwise). */
export const MIN_COLS = 60;
export const MIN_ROWS = 14;
export const WIDE_COLS = 110;
export const RAIL_WIDTH = 26;
export const PREVIEW_CAP = 60;
export const CHROME_ROWS = 3;

export type LayoutMode = "wide" | "medium" | "tooSmall";
export interface Layout {
  mode: LayoutMode;
  railWidth: number;
  previewWidth: number;
  bodyRows: number;
}

export function computeLayout(columns: number, rows: number): Layout {
  const bodyRows = Math.max(0, rows - CHROME_ROWS);
  if (columns < MIN_COLS || rows < MIN_ROWS) {
    return { mode: "tooSmall", railWidth: 0, previewWidth: 0, bodyRows };
  }
  if (columns >= WIDE_COLS) {
    return {
      mode: "wide",
      railWidth: RAIL_WIDTH,
      previewWidth: Math.min(PREVIEW_CAP, Math.floor(columns * 0.4)),
      bodyRows,
    };
  }
  return { mode: "medium", railWidth: RAIL_WIDTH, previewWidth: 0, bodyRows };
}
```

`src/tui/useTerminalSize.ts`:

```ts
import { useWindowSize } from "ink";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/** Ink's useWindowSize with a test seam: ink-testing-library has no resizable
 * stdout, so tests inject a fixed size. Falls back to 100×30 when the stream
 * reports nothing (non-TTY). The hook is called unconditionally (rules of hooks). */
export function useTerminalSize(override?: TerminalSize): TerminalSize {
  const ws = useWindowSize();
  if (override) return override;
  return { columns: ws.columns || 100, rows: ws.rows || 30 };
}
```

- [ ] **Step 4: Verify green** — `npx vitest run tests/tuiFoundation.test.ts > /tmp/t1 2>&1; echo "exit: $?"; tail -5 /tmp/t1` → PASS. Also `npm run build` (exit 0) to prove the `ink` named import compiles.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/theme.ts src/tui/window.ts src/tui/layout.ts src/tui/useTerminalSize.ts tests/tuiFoundation.test.ts
git add src/tui/theme.ts src/tui/window.ts src/tui/layout.ts src/tui/useTerminalSize.ts tests/tuiFoundation.test.ts
git commit -m "feat(tui): workspace foundation — theme tokens, window slicing, layout breakpoints"
```

---

### Task 2: Chrome — Header, Toast, Footer, hintsFor

**Files:**

- Create: `src/tui/components/Chrome.tsx`
- Test: `tests/tuiChrome.test.tsx`

**Interfaces:**

- Consumes: `theme`, `ToastKind`, `toastColor` (Task 1); `LayoutMode` (Task 1).
- Produces (Task 7/8 rely on):
  - `Header({ repoNwo, daemonUp, uptimeSeconds, queueRunning, queueWaiting, watchlistError, now }: { repoNwo: string | null; daemonUp: boolean | null; uptimeSeconds: number | null; queueRunning: number; queueWaiting: number; watchlistError: string | null; now: Date })`
  - `Toast({ toast }: { toast: { kind: ToastKind; text: string } | null })` — always exactly 1 row.
  - `Footer({ hints }: { hints: [string, string][] })`
  - `hintsFor(view: HintView, pane: 1 | 2 | 3, mode: LayoutMode, filtering: boolean): [string, string][]` with `type HintView = "main" | "detail" | "help" | "addRepo" | "palette" | "cmdOutput" | "queue"`

- [ ] **Step 1: Failing tests** — `tests/tuiChrome.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Header, Toast, Footer, hintsFor } from "../src/tui/components/Chrome.js";

const NOW = new Date("2026-07-07T14:05:00");

describe("Header", () => {
  it("brand chip, repo, daemon up, queue chip, clock", () => {
    const f = render(
      <Header
        repoNwo="acme/api"
        daemonUp={true}
        uptimeSeconds={11040}
        queueRunning={1}
        queueWaiting={2}
        watchlistError={null}
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("junco");
    expect(f).toContain("acme/api");
    expect(f).toContain("daemon ●");
    expect(f).toContain("3h4m");
    expect(f).toContain("◐1 ⏳2");
    expect(f).toMatch(/\d{2}:\d{2}/);
  });
  it("daemon down and watchlist warn chip", () => {
    const f = render(
      <Header
        repoNwo={null}
        daemonUp={false}
        uptimeSeconds={null}
        queueRunning={0}
        queueWaiting={0}
        watchlistError="corrupt json"
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("daemon ○");
    expect(f).toContain("watchlist!");
    expect(f).not.toContain("◐0"); // queue chip hidden when empty
  });
});

describe("Toast", () => {
  it("renders the text when live and a blank row when not", () => {
    expect(render(<Toast toast={{ kind: "error", text: "gh boom" }} />).lastFrame()).toContain(
      "gh boom",
    );
    expect(render(<Toast toast={null} />).lastFrame()).not.toContain("gh boom");
  });
});

describe("Footer / hintsFor", () => {
  it("renders key·label pairs", () => {
    const f = render(
      <Footer
        hints={[
          ["j/k", "move"],
          ["q", "quit"],
        ]}
      />,
    ).lastFrame()!;
    expect(f).toContain("j/k");
    expect(f).toContain("move");
    expect(f).toContain("q");
  });
  it("main pane 2 wide advertises preview enter, filter, panes", () => {
    const keys = hintsFor("main", 2, "wide", false).map(([k]) => k);
    expect(keys).toContain("enter");
    expect(keys).toContain("/");
    expect(keys).toContain("1/2/3");
    expect(keys).toContain("q");
  });
  it("medium mode enter says detail and 3rd pane hint drops to 1/2", () => {
    const pairs = hintsFor("main", 2, "medium", false);
    expect(pairs.find(([k]) => k === "enter")?.[1]).toBe("detail");
    expect(pairs.map(([k]) => k)).toContain("1/2");
  });
  it("filtering mode replaces everything with the filter contract", () => {
    expect(hintsFor("main", 2, "wide", true)).toEqual([
      ["type", "filter"],
      ["enter", "apply"],
      ["esc", "clear"],
    ]);
  });
  it("queue view keeps [ / ] scroll and esc/t back", () => {
    const keys = hintsFor("queue", 2, "wide", false).map(([k]) => k);
    expect(keys).toContain("[ / ]");
    expect(keys).toContain("esc/t");
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/tuiChrome.test.tsx > /tmp/t2 2>&1; echo "exit: $?"; tail -5 /tmp/t2` → FAIL.

- [ ] **Step 3: Implement** `src/tui/components/Chrome.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { theme, toastColor, type ToastKind } from "../theme.js";
import type { LayoutMode } from "../layout.js";

export type HintView = "main" | "detail" | "help" | "addRepo" | "palette" | "cmdOutput" | "queue";

function fmtUp(s: number | null): string {
  if (s === null) return "";
  if (s < 3600) return ` up ${Math.floor(s / 60)}m`;
  return ` up ${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** Row 1: brand chip · active repo · (right) watchlist warn, daemon, queue, clock. */
export function Header({
  repoNwo,
  daemonUp,
  uptimeSeconds,
  queueRunning,
  queueWaiting,
  watchlistError,
  now,
}: {
  repoNwo: string | null;
  daemonUp: boolean | null;
  uptimeSeconds: number | null;
  queueRunning: number;
  queueWaiting: number;
  watchlistError: string | null;
  now: Date;
}): React.JSX.Element {
  const daemon =
    daemonUp === null ? "daemon …" : daemonUp ? `daemon ●${fmtUp(uptimeSeconds)}` : "daemon ○";
  const hhmm = now.toTimeString().slice(0, 5);
  return (
    <Box paddingX={1} gap={2}>
      <Text backgroundColor={theme.accent} color="#191724" bold>
        {" junco "}
      </Text>
      <Text bold wrap="truncate">
        {repoNwo ?? "no repo"}
      </Text>
      <Box flexGrow={1} />
      {watchlistError !== null && <Text color={theme.warn}>watchlist!</Text>}
      <Text color={daemonUp ? theme.success : theme.warn}>{daemon}</Text>
      {queueRunning + queueWaiting > 0 && (
        <Text color={theme.info}>
          ◐{queueRunning} ⏳{queueWaiting}
        </Text>
      )}
      <Text dimColor>{hhmm}</Text>
    </Box>
  );
}

/** Row n-1: reserved single toast row (stable layout — blank when idle). */
export function Toast({
  toast,
}: {
  toast: { kind: ToastKind; text: string } | null;
}): React.JSX.Element {
  return (
    <Box paddingX={1} height={1}>
      {toast ? (
        <Text color={toastColor(toast.kind)} wrap="truncate-end">
          {toast.text.replace(/\s*[\r\n]+\s*/g, " · ")}
        </Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}

/** Row n: context key hints — accent key, muted label, graceful truncation. */
export function Footer({ hints }: { hints: [string, string][] }): React.JSX.Element {
  return (
    <Box paddingX={1} height={1}>
      <Text wrap="truncate-end">
        {hints.map(([k, label], i) => (
          <Text key={k}>
            {i > 0 ? <Text dimColor> · </Text> : null}
            <Text color={theme.accent}>{k}</Text>
            <Text dimColor> {label}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

/** The full key set for the current context (the ? modal is the long form). */
export function hintsFor(
  view: HintView,
  pane: 1 | 2 | 3,
  mode: LayoutMode,
  filtering: boolean,
): [string, string][] {
  if (filtering) {
    return [
      ["type", "filter"],
      ["enter", "apply"],
      ["esc", "clear"],
    ];
  }
  switch (view) {
    case "detail":
      return [
        ["[ / ]", "scroll"],
        ["esc", "back"],
      ];
    case "queue":
      return [
        ["[ / ]", "scroll"],
        ["esc/t", "back"],
      ];
    case "palette":
      return [
        ["type", "filter"],
        ["↑/↓", "move"],
        ["enter", "run"],
        ["esc", "close"],
      ];
    case "cmdOutput":
      return [
        ["[ / ]", "scroll"],
        ["r", "re-run"],
        ["esc", "back"],
      ];
    case "addRepo":
      return [
        ["enter", "next/submit"],
        ["esc", "cancel"],
      ];
    case "help":
      return [["any key", "close"]];
    case "main":
      break;
  }
  const panesHint: [string, string] = mode === "wide" ? ["1/2/3", "panes"] : ["1/2", "panes"];
  if (pane === 1) {
    return [
      ["j/k", "move"],
      panesHint,
      ["w", "add repo"],
      ["x", "unwatch"],
      ["r", "refresh"],
      [":", "commands"],
      ["?", "help"],
      ["q", "quit"],
    ];
  }
  if (pane === 3) {
    return [["j/k · [ / ]", "scroll"], panesHint, ["o", "browser"], ["?", "help"], ["q", "quit"]];
  }
  return [
    ["j/k", "move"],
    ["enter", mode === "wide" ? "preview" : "detail"],
    ["d", "dispatch"],
    ["a", "approve"],
    ["/", "filter"],
    panesHint,
    ["t", "queue"],
    ["?", "help"],
    ["q", "quit"],
  ];
}
```

- [ ] **Step 4: Verify green** — `npx vitest run tests/tuiChrome.test.tsx > /tmp/t2 2>&1; echo "exit: $?"; tail -5 /tmp/t2` → PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/Chrome.tsx tests/tuiChrome.test.tsx
git add src/tui/components/Chrome.tsx tests/tuiChrome.test.tsx
git commit -m "feat(tui): chrome — header chips, toast row, footer hints"
```

---

### Task 3: Rail — repos + compact queue card (pane 1)

**Files:**

- Create: `src/tui/components/Rail.tsx`
- Test: `tests/tuiRail.test.tsx`

**Interfaces:**

- Consumes: `theme` (T1), `windowSlice` (T1), `stateMeta`/`IssueLifecycle` from `src/tui/state.ts`, `QueueSnapshot` from `src/tui/queueSnapshot.ts`, `queueLabel` from `src/tui/queueFmt.ts`.
- Produces: `Rail(props: RailProps)` and `interface RailProps { repos: RailRepo[]; selected: number; focused: boolean; queue: QueueSnapshot | null; width: number; height: number }` with `interface RailRepo { nwo: string; fromConfig: boolean; counts: Partial<Record<IssueLifecycle, number>> }` (same shape as today's `RepoRow`).

- [ ] **Step 1: Failing tests** — `tests/tuiRail.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Rail } from "../src/tui/components/Rail.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";

const QUEUE: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  running: [
    {
      id: "gh-a-b-46",
      github: { nwo: "a/b", issue: 46, kind: "pr" },
      turns: 14,
      lastTool: "bash",
      outputTokens: 900,
      startedAt: null,
      stale: false,
    },
  ],
  waiting: [
    {
      id: "w1",
      github: null,
      kind: "ask",
      priority: "normal",
      retryCount: 0,
      notBefore: null,
      deferred: false,
    },
    {
      id: "w2",
      github: null,
      kind: "pr",
      priority: "normal",
      retryCount: 0,
      notBefore: null,
      deferred: false,
    },
  ],
  recent: [],
  error: null,
};

const repos = [
  { nwo: "acme/api", fromConfig: false, counts: { "plan-ready": 2 } },
  { nwo: "acme/web", fromConfig: true, counts: {} },
];

describe("Rail", () => {
  it("numbered title, selection bar, config marker, badges, queue card", () => {
    const f = render(
      <Rail repos={repos} selected={0} focused={true} queue={QUEUE} width={26} height={20} />,
    ).lastFrame()!;
    expect(f).toContain("1 repos");
    expect(f).toContain("▌");
    expect(f).toContain("acme/api");
    expect(f).toContain("2●");
    expect(f).toContain("(cfg)");
    expect(f).toContain("queue");
    expect(f).toContain("#46 exec");
    expect(f).toContain("turn 14");
    expect(f).toContain("2 waiting");
  });
  it("empty repos state and daemon-down warning", () => {
    const down: QueueSnapshot = { ...QUEUE, daemonUp: false, running: [] };
    const f = render(
      <Rail repos={[]} selected={0} focused={false} queue={down} width={26} height={20} />,
    ).lastFrame()!;
    expect(f).toContain('none watched — press "w"');
    expect(f).toContain("daemon ○ down");
  });
  it("windows long repo lists to the height budget with a position line", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      nwo: `o/r${i}`,
      fromConfig: false,
      counts: {},
    }));
    const f = render(
      <Rail repos={many} selected={29} focused={true} queue={null} width={26} height={16} />,
    ).lastFrame()!;
    expect(f).toContain("o/r29"); // cursor stays visible
    expect(f).not.toContain("o/r0"); // top scrolled out
    expect(f).toContain("30/30");
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/tuiRail.test.tsx > /tmp/t3 2>&1; echo "exit: $?"; tail -5 /tmp/t3` → FAIL.

- [ ] **Step 3: Implement** `src/tui/components/Rail.tsx`:

```tsx
import React, { useRef } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { windowSlice } from "../window.js";
import { stateMeta, type IssueLifecycle } from "../state.js";
import type { QueueSnapshot } from "../queueSnapshot.js";
import { queueLabel } from "../queueFmt.js";

export interface RailRepo {
  nwo: string;
  fromConfig: boolean;
  counts: Partial<Record<IssueLifecycle, number>>;
}

export interface RailProps {
  repos: RailRepo[];
  selected: number;
  focused: boolean;
  queue: QueueSnapshot | null;
  width: number;
  height: number;
}

const COUNT_ORDER: IssueLifecycle[] = ["plan-ready", "working", "failed"];
const QUEUE_CARD_ROWS = 5; // separator + "queue" + running + waiting/daemon lines

/** Pane 1: watched repos on top, a compact queue card pinned below.
 * Absorbs the old RepoList and QueueStrip. */
export function Rail({
  repos,
  selected,
  focused,
  queue,
  width,
  height,
}: RailProps): React.JSX.Element {
  // height budget: 2 border rows + title + optional position line + queue card
  const listHeight = Math.max(1, height - 2 - 1 - 1 - QUEUE_CARD_ROWS);
  const prev = useRef(0);
  const { start, end } = windowSlice(repos.length, listHeight, selected, prev.current);
  prev.current = start;
  const running = queue?.running ?? [];
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      width={width}
      height={height}
    >
      <Text bold color={focused ? theme.accent : undefined}>
        1 repos
      </Text>
      {repos.length === 0 && <Text dimColor>none watched — press "w"</Text>}
      {repos.slice(start, end).map((r, i) => {
        const idx = start + i;
        const sel = idx === selected;
        const badges = COUNT_ORDER.filter((s) => (r.counts[s] ?? 0) > 0)
          .map((s) => `${r.counts[s]}${stateMeta(s).glyph}`)
          .join(" ");
        return (
          <Box key={r.nwo} width="100%" backgroundColor={sel ? theme.selectionBg : undefined}>
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Text wrap="truncate">
              {r.nwo}
              {r.fromConfig ? " (cfg)" : ""}
              {badges ? `  ${badges}` : ""}
            </Text>
          </Box>
        );
      })}
      {repos.length > listHeight && (
        <Text dimColor>
          {selected + 1}/{repos.length}
        </Text>
      )}
      <Box flexGrow={1} />
      <Text dimColor>{"─".repeat(Math.max(1, width - 4))}</Text>
      <Text bold>queue</Text>
      {queue === null && <Text dimColor>loading…</Text>}
      {queue?.error != null && (
        <Text dimColor wrap="truncate-end">
          unavailable: {queue.error}
        </Text>
      )}
      {queue !== null && queue.error === null && (
        <>
          {running.length === 0 && queue.waiting.length === 0 && queue.daemonUp && (
            <Text dimColor>idle</Text>
          )}
          {running.slice(0, 1).map((r) => (
            <Text key={r.id} wrap="truncate">
              <Text color={theme.info}>◐ </Text>
              {queueLabel(r.github, r.id)}
              {r.turns !== null ? <Text dimColor> turn {r.turns}</Text> : null}
            </Text>
          ))}
          {running.length > 1 && <Text dimColor>+{running.length - 1} more running</Text>}
          {queue.waiting.length > 0 && <Text dimColor>{queue.waiting.length} waiting</Text>}
          {!queue.daemonUp && <Text color={theme.warn}>daemon ○ down</Text>}
        </>
      )}
    </Box>
  );
}
```

Note: the daemon-down test asserts `"daemon ○ down"` — keep that exact string.

- [ ] **Step 4: Verify green** — `npx vitest run tests/tuiRail.test.tsx > /tmp/t3 2>&1; echo "exit: $?"; tail -5 /tmp/t3` → PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/Rail.tsx tests/tuiRail.test.tsx
git add src/tui/components/Rail.tsx tests/tuiRail.test.tsx
git commit -m "feat(tui): rail — repos with selection bars + compact queue card"
```

---

### Task 4: IssueList (pane 2) + filterIssues

**Files:**

- Create: `src/tui/components/IssueList.tsx`
- Modify: `src/tui/state.ts` (append `filterIssues`)
- Test: `tests/tuiIssueList.test.tsx`

**Interfaces:**

- Consumes: `theme`, `windowSlice` (T1); `DashIssue`, `deriveState`, `stateMeta` from `state.ts`; `Spinner`.
- Produces:
  - `filterIssues(issues: DashIssue[], q: string, trigger: string): DashIssue[]` (exported from `state.ts`) — case-insensitive substring across `#<number>`, title, and state badge; empty/whitespace query returns the input array.
  - `IssueList(props: IssueListProps)`, `interface IssueListProps { issues: DashIssue[]; trigger: string; selected: number; focused: boolean; refreshing: boolean; filter: string; filtering: boolean; height: number; now: Date }` (issues arrive ALREADY filtered; `filter` is displayed as a chip).
  - `relTime(iso: string, now: Date): string` exported for reuse.

- [ ] **Step 1: Failing tests** — `tests/tuiIssueList.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { IssueList, relTime } from "../src/tui/components/IssueList.js";
import { filterIssues, type DashIssue } from "../src/tui/state.js";

const NOW = new Date("2026-07-07T14:00:00Z");
const iss = (number: number, title: string, labels: string[] = ["junco"]): DashIssue => ({
  number,
  title,
  labels,
  updatedAt: "2026-07-07T13:00:00Z",
  url: `https://github.com/a/b/issues/${number}`,
});

describe("filterIssues", () => {
  const list = [
    iss(52, "Fix reef colors", ["junco", "junco:plan-ready"]),
    iss(61, "Add tide tables"),
  ];
  it("matches number, title, and badge, case-insensitively", () => {
    expect(filterIssues(list, "#52", "junco").map((i) => i.number)).toEqual([52]);
    expect(filterIssues(list, "TIDE", "junco").map((i) => i.number)).toEqual([61]);
    expect(filterIssues(list, "plan-ready", "junco").map((i) => i.number)).toEqual([52]);
  });
  it("empty query returns the input unchanged", () => {
    expect(filterIssues(list, "  ", "junco")).toBe(list);
  });
});

describe("relTime", () => {
  it("buckets minutes/hours/days", () => {
    expect(relTime("2026-07-07T13:59:40Z", NOW)).toBe("now");
    expect(relTime("2026-07-07T13:00:00Z", NOW)).toBe("60m");
    expect(relTime("2026-07-06T14:00:00Z", NOW)).toBe("24h");
    expect(relTime("2026-07-04T14:00:00Z", NOW)).toBe("3d");
  });
});

describe("IssueList", () => {
  const three = [
    iss(52, "Fix reef colors", ["junco", "junco:plan-ready"]),
    iss(46, "Bleaching alert", ["junco", "junco:working"]),
    iss(61, "Add tide tables"),
  ];
  it("numbered title with count, selection bar, badges, reltime", () => {
    const f = render(
      <IssueList
        issues={three}
        trigger="junco"
        selected={0}
        focused={true}
        refreshing={false}
        filter=""
        filtering={false}
        height={20}
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("2 issues · 3");
    expect(f).toContain("▌");
    expect(f).toContain("#52");
    expect(f).toContain("plan-ready");
    expect(f).toContain("60m");
  });
  it("filter chip renders in the title while active", () => {
    const f = render(
      <IssueList
        issues={[three[0]]}
        trigger="junco"
        selected={0}
        focused={true}
        refreshing={false}
        filter="reef"
        filtering={true}
        height={20}
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("/reef");
  });
  it("no-match filter empty state names the query and the way out", () => {
    const f = render(
      <IssueList
        issues={[]}
        trigger="junco"
        selected={0}
        focused={true}
        refreshing={false}
        filter="zzz"
        filtering={false}
        height={20}
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("no issues match /zzz");
    expect(f).toContain("esc");
  });
  it("windows to height with a position indicator", () => {
    const many = Array.from({ length: 40 }, (_, i) => iss(i + 1, `Issue number ${i + 1}`));
    const f = render(
      <IssueList
        issues={many}
        trigger="junco"
        selected={39}
        focused={true}
        refreshing={false}
        filter=""
        filtering={false}
        height={12}
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("Issue number 40");
    expect(f).not.toContain("Issue number 1 "); // note trailing space — #1's row, not #10+
    expect(f).toContain("40/40");
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/tuiIssueList.test.tsx > /tmp/t4 2>&1; echo "exit: $?"; tail -5 /tmp/t4` → FAIL.

- [ ] **Step 3: Implement.** Append to `src/tui/state.ts`:

```ts
/** Live `/` filter: case-insensitive substring across #number, title, and the
 * lifecycle badge. Blank query returns the input array identity (cheap no-op). */
export function filterIssues(issues: DashIssue[], q: string, trigger: string): DashIssue[] {
  const s = q.trim().toLowerCase();
  if (s === "") return issues;
  return issues.filter((i) => {
    const badge = stateMeta(deriveState(i.labels, trigger)).badge;
    return `#${i.number}`.includes(s) || i.title.toLowerCase().includes(s) || badge.includes(s);
  });
}
```

Create `src/tui/components/IssueList.tsx`:

```tsx
import React, { useRef } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { windowSlice } from "../window.js";
import { deriveState, stateMeta, type DashIssue } from "../state.js";
import { Spinner } from "./Spinner.js";

export function relTime(iso: string, now: Date): string {
  const ms = now.getTime() - (Date.parse(iso) || now.getTime());
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export interface IssueListProps {
  issues: DashIssue[]; // already filtered by the App
  trigger: string;
  selected: number;
  focused: boolean;
  refreshing: boolean;
  filter: string;
  filtering: boolean;
  height: number;
  now: Date;
}

/** Pane 2: windowed issue rows with full-row selection bars and aligned
 * metadata. Replaces IssueTable. */
export function IssueList({
  issues,
  trigger,
  selected,
  focused,
  refreshing,
  filter,
  filtering,
  height,
  now,
}: IssueListProps): React.JSX.Element {
  const listHeight = Math.max(1, height - 4); // borders + title + position line
  const prev = useRef(0);
  const { start, end } = windowSlice(issues.length, listHeight, selected, prev.current);
  prev.current = start;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      flexGrow={1}
      height={height}
    >
      <Text bold color={focused ? theme.accent : undefined}>
        2 issues · {issues.length}
        {filter !== "" && (
          <Text color={theme.accent} bold={filtering}>
            {" "}
            /{filter}
          </Text>
        )}
        {refreshing && (
          <>
            {" "}
            <Spinner />
          </>
        )}
      </Text>
      {issues.length === 0 && filter !== "" && (
        <Text dimColor>no issues match /{filter} — esc clears the filter</Text>
      )}
      {issues.length === 0 && filter === "" && (
        <Text dimColor>
          no open issues — create one on GitHub, then select it here and press d to dispatch
        </Text>
      )}
      {issues.slice(start, end).map((iss, i) => {
        const idx = start + i;
        const sel = idx === selected;
        const st = deriveState(iss.labels, trigger);
        const meta = stateMeta(st);
        return (
          <Box
            key={iss.number}
            width="100%"
            backgroundColor={sel ? theme.selectionBg : undefined}
            gap={1}
          >
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Text color={meta.color}>{meta.glyph}</Text>
            <Text dimColor={!sel}>{`#${iss.number}`.padStart(5)}</Text>
            <Box flexGrow={1} minWidth={0}>
              <Text wrap="truncate">{iss.title}</Text>
            </Box>
            <Text color={meta.color}>{meta.badge}</Text>
            <Text dimColor>{relTime(iss.updatedAt, now)}</Text>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      {issues.length > listHeight && (
        <Text dimColor>
          {Math.min(selected + 1, issues.length)}/{issues.length}
        </Text>
      )}
    </Box>
  );
}
```

- [ ] **Step 4: Verify green** — `npx vitest run tests/tuiIssueList.test.tsx tests/tuiState.test.ts > /tmp/t4 2>&1; echo "exit: $?"; tail -5 /tmp/t4` → PASS (tuiState confirms the state.ts append broke nothing).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/IssueList.tsx src/tui/state.ts tests/tuiIssueList.test.tsx
git add src/tui/components/IssueList.tsx src/tui/state.ts tests/tuiIssueList.test.tsx
git commit -m "feat(tui): issue list — row bars, windowing, live filter"
```

---

### Task 5: Preview (pane 3 / medium full-body)

**Files:**

- Create: `src/tui/components/Preview.tsx`
- Test: `tests/tuiPreview.test.tsx`

**Interfaces:**

- Consumes: `theme`, `DashIssue`, `deriveState`/`stateMeta`, `Spinner`.
- Produces: `Preview(props: PreviewProps)`, `interface PreviewProps { issue: DashIssue | null; trigger: string; body: string | null; planComment: string | null; loading: boolean; error: string | null; scroll: number; focused: boolean; height: number; width?: number; paneNumber?: boolean }` (`paneNumber` true → title `3 preview`; false → plain title for the medium full-body view).

- [ ] **Step 1: Failing tests** — `tests/tuiPreview.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Preview } from "../src/tui/components/Preview.js";
import type { DashIssue } from "../src/tui/state.js";

const ISSUE: DashIssue = {
  number: 52,
  title: "Fix reef colors",
  labels: ["junco", "junco:plan-ready"],
  updatedAt: "2026-07-07T13:00:00Z",
  url: "https://github.com/a/b/issues/52",
};
const base = {
  trigger: "junco",
  body: null as string | null,
  planComment: null as string | null,
  loading: false,
  error: null as string | null,
  scroll: 0,
  focused: false,
  height: 20,
};

describe("Preview", () => {
  it("empty state explains itself", () => {
    const f = render(<Preview {...base} issue={null} paneNumber />).lastFrame()!;
    expect(f).toContain("3 preview");
    expect(f).toContain("select an issue");
  });
  it("renders title, badge, body, and plan divider", () => {
    const f = render(
      <Preview
        {...base}
        issue={ISSUE}
        body={"line one\nline two"}
        planComment={"<!-- junco:plan -->\nthe plan"}
        paneNumber
      />,
    ).lastFrame()!;
    expect(f).toContain("#52 Fix reef colors");
    expect(f).toContain("plan-ready");
    expect(f).toContain("line one");
    expect(f).toContain("── plan ──");
    expect(f).toContain("the plan");
  });
  it("loading and error states", () => {
    expect(render(<Preview {...base} issue={ISSUE} loading paneNumber />).lastFrame()).toContain(
      "loading",
    );
    expect(
      render(<Preview {...base} issue={ISSUE} error="gh exploded" paneNumber />).lastFrame(),
    ).toContain("gh exploded");
  });
  it("windows long bodies by scroll with a position footer", () => {
    const body = Array.from({ length: 60 }, (_, i) => `L${i + 1}`).join("\n");
    const top = render(<Preview {...base} issue={ISSUE} body={body} paneNumber />).lastFrame()!;
    const scrolled = render(
      <Preview {...base} issue={ISSUE} body={body} scroll={30} paneNumber />,
    ).lastFrame()!;
    expect(top).toContain("L1");
    expect(scrolled).not.toContain("L1\n");
    expect(scrolled).toContain("L31");
    expect(top).toContain("[ / ] scroll");
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/tuiPreview.test.tsx > /tmp/t5 2>&1; echo "exit: $?"; tail -5 /tmp/t5` → FAIL.

- [ ] **Step 3: Implement** `src/tui/components/Preview.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { deriveState, stateMeta, type DashIssue } from "../state.js";
import { Spinner } from "./Spinner.js";

export interface PreviewProps {
  issue: DashIssue | null;
  trigger: string;
  body: string | null;
  planComment: string | null;
  loading: boolean;
  error: string | null;
  scroll: number;
  focused: boolean;
  height: number;
  width?: number;
  paneNumber?: boolean;
}

/** Pane 3 (wide) and the medium-mode full-body detail. Replaces IssueDetail. */
export function Preview({
  issue,
  trigger,
  body,
  planComment,
  loading,
  error,
  scroll,
  focused,
  height,
  width,
  paneNumber = false,
}: PreviewProps): React.JSX.Element {
  const viewHeight = Math.max(1, height - 4); // borders + title + footer line
  const lines: string[] = [];
  if (body !== null) lines.push(...body.split("\n"));
  if (planComment !== null) lines.push("", "── plan ──", ...planComment.split("\n"));
  else if (issue !== null && body !== null && !loading) lines.push("", "(no plan posted yet)");
  const visible = lines.slice(scroll, scroll + viewHeight);
  const st = issue ? deriveState(issue.labels, trigger) : null;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      height={height}
      width={width}
      flexGrow={width === undefined ? 1 : undefined}
    >
      <Text bold color={focused ? theme.accent : undefined} wrap="truncate">
        {paneNumber ? "3 preview" : "preview"}
        {issue ? ` · #${issue.number}` : ""}
      </Text>
      {issue === null && <Text dimColor>select an issue — its body and plan render here</Text>}
      {issue !== null && (
        <Text bold wrap="truncate">
          #{issue.number} {issue.title}{" "}
          {st !== null && <Text color={stateMeta(st).color}>[{stateMeta(st).badge}]</Text>}
        </Text>
      )}
      {loading && (
        <Text dimColor>
          <Spinner /> loading issue details…
        </Text>
      )}
      {error !== null && <Text color={theme.error}>{error}</Text>}
      {visible.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
      <Box flexGrow={1} />
      {lines.length > viewHeight && (
        <Text dimColor>
          [ / ] scroll · {scroll + 1}-{Math.min(scroll + viewHeight, lines.length)}/{lines.length}
        </Text>
      )}
    </Box>
  );
}
```

- [ ] **Step 4: Verify green** — `npx vitest run tests/tuiPreview.test.tsx > /tmp/t5 2>&1; echo "exit: $?"; tail -5 /tmp/t5` → PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/Preview.tsx tests/tuiPreview.test.tsx
git add src/tui/components/Preview.tsx tests/tuiPreview.test.tsx
git commit -m "feat(tui): preview pane — master-detail body/plan with scroll"
```

---

### Task 6: Modal, HelpModal, and modal-ready Palette/AddRepoForm

**Files:**

- Create: `src/tui/components/Modal.tsx`, `src/tui/components/HelpModal.tsx`
- Modify: `src/tui/components/CommandPalette.tsx`, `src/tui/components/AddRepoForm.tsx` (drop their own outer border/title — the Modal supplies both; ALL text content stays byte-identical so existing tuiPalette/tuiApp assertions keep passing)
- Test: `tests/tuiModal.test.tsx`

**Interfaces:**

- Consumes: `theme` (T1), `hintsFor`/`HintView` (T2), existing palette/add-repo props (unchanged).
- Produces:
  - `Modal({ title, minWidth?, children })` — double border, accent border+title, paddingX 2, paddingY 1.
  - `Center({ children })` — `flexGrow 1, justifyContent="center", alignItems="center"`.
  - `HelpModal({ view, pane, mode, trigger }: { view: HintView; pane: 1 | 2 | 3; mode: LayoutMode; trigger: string })` — categorized help, current-context section first.

- [ ] **Step 1: Failing tests** — `tests/tuiModal.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { Modal, Center } from "../src/tui/components/Modal.js";
import { HelpModal } from "../src/tui/components/HelpModal.js";

describe("Modal / Center", () => {
  it("frames children with an accent double border and title", () => {
    const f = render(
      <Center>
        <Modal title="hello there">
          <Text>content line</Text>
        </Modal>
      </Center>,
    ).lastFrame()!;
    expect(f).toContain("hello there");
    expect(f).toContain("content line");
    expect(f).toContain("═"); // double border
  });
});

describe("HelpModal", () => {
  it("current context first, then categories, action keys present", () => {
    const f = render(<HelpModal view="main" pane={2} mode="wide" trigger="junco" />).lastFrame()!;
    const ctx = f.indexOf("this view");
    const nav = f.indexOf("navigate");
    expect(ctx).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(ctx); // context section renders first
    expect(f).toContain("act on issue");
    expect(f).toContain("dispatch (adds `junco`)");
    expect(f).toContain("1/2/3");
    expect(f).toContain("/"); // filter key documented
    expect(f).toContain("press any key to close");
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/tuiModal.test.tsx > /tmp/t6 2>&1; echo "exit: $?"; tail -5 /tmp/t6` → FAIL.

- [ ] **Step 3: Implement.**

`src/tui/components/Modal.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

/** Centering wrapper for the body area (Ink has no z-axis; modals replace the
 * body rather than floating over it — header/footer stay visible around them). */
export function Center({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Box flexGrow={1} justifyContent="center" alignItems="center">
      {children}
    </Box>
  );
}

export function Modal({
  title,
  minWidth = 50,
  children,
}: {
  title: string;
  minWidth?: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
      minWidth={minWidth}
    >
      <Text bold color={theme.accent}>
        {title}
      </Text>
      {children}
    </Box>
  );
}
```

`src/tui/components/HelpModal.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { Modal } from "./Modal.js";
import { hintsFor, type HintView } from "./Chrome.js";
import type { LayoutMode } from "../layout.js";

function Section({ title, rows }: { title: string; rows: [string, string][] }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      {rows.map(([k, d]) => (
        <Box key={k} gap={2}>
          <Box minWidth={12}>
            <Text color={theme.accent}>{k}</Text>
          </Box>
          <Text>{d}</Text>
        </Box>
      ))}
    </Box>
  );
}

/** Categorized help, k9s-style: what applies to the CURRENT view first. */
export function HelpModal({
  view,
  pane,
  mode,
  trigger,
}: {
  view: HintView;
  pane: 1 | 2 | 3;
  mode: LayoutMode;
  trigger: string;
}): React.JSX.Element {
  return (
    <Modal title="junco dashboard — keys" minWidth={64}>
      <Text dimColor>
        flow: d dispatch → junco posts a plan → read it in the preview → a approve → PR opens
      </Text>
      <Section title="this view" rows={hintsFor(view, pane, mode, false)} />
      <Section
        title="navigate"
        rows={[
          ["j/k", "move selection"],
          ["g/G", "first / last"],
          ["1/2/3", "jump pane (3 = preview, wide terminals)"],
          ["tab · h/l", "cycle panes"],
          ["[ / ]", "scroll preview / queue / output"],
          ["enter", mode === "wide" ? "focus the preview pane" : "open issue detail"],
        ]}
      />
      <Section
        title="act on issue"
        rows={[
          ["d", `dispatch (adds \`${trigger}\`)`],
          ["D", "dispatch as ask (read-only Q&A)"],
          ["a", "approve the posted plan"],
          ["R", "re-plan / re-cycle (by state)"],
          ["o", "open in browser"],
        ]}
      />
      <Section
        title="panes & views"
        rows={[
          ["/", "filter issues (esc clears)"],
          ["w", "add repo to watchlist"],
          ["x", "unwatch repo"],
          ["r", "refresh now"],
          ["t", "queue view"],
          [":", "command palette"],
        ]}
      />
      <Section
        title="system"
        rows={[
          ["?", "this help"],
          ["q", "quit (terminal restored)"],
        ]}
      />
      <Box marginTop={1}>
        <Text dimColor>press any key to close</Text>
      </Box>
    </Modal>
  );
}
```

`CommandPalette.tsx` — change ONLY the outer wrapper: replace the root `<Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1} minWidth={60}>` with `<Box flexDirection="column" minWidth={60}>` and delete the `<Text bold>run a junco command</Text>` line (the App will render `<Modal title="run a junco command">` around it in Task 7/8). Everything else byte-identical.

`AddRepoForm.tsx` — same treatment: root becomes `<Box flexDirection="column" minWidth={50}>`; delete `<Text bold>add repo to watchlist</Text>` (Modal supplies the title).

- [ ] **Step 4: Verify green + no regressions** — `npx vitest run tests/tuiModal.test.tsx tests/tuiPalette.test.tsx tests/tuiApp.test.tsx tests/tuiComponents.test.tsx > /tmp/t6 2>&1; echo "exit: $?"; tail -8 /tmp/t6`. If a tuiPalette/tuiApp/tuiComponents assertion referenced the deleted inline titles ("run a junco command" / "add repo to watchlist"), those strings are now supplied by the App-level Modal, which is NOT yet wired — update ONLY such title assertions to the still-present body text (e.g. assert `"Runs the junco CLI against this dashboard's config"` for the palette, `"Watch a repository"` for the form), noting each change in the commit message.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/Modal.tsx src/tui/components/HelpModal.tsx src/tui/components/CommandPalette.tsx src/tui/components/AddRepoForm.tsx tests/tuiModal.test.tsx
git add -A src/tui/components tests/tuiModal.test.tsx tests/tuiPalette.test.tsx tests/tuiApp.test.tsx tests/tuiComponents.test.tsx
git commit -m "feat(tui): centered modal frame, categorized help, modal-ready palette and add-repo"
```

---

### Task 7: Workspace frame + QueueView re-skin

**Files:**

- Create: `src/tui/components/Workspace.tsx`
- Modify: `src/tui/components/QueueView.tsx` (theme tokens + `height`/`focused` props replacing the PAGE const)
- Test: `tests/tuiWorkspace.test.tsx`; Modify: `tests/tuiQueue.test.tsx` (QueueView call sites gain `height={20} focused={false}`)

**Interfaces:**

- Consumes: T1 (`theme`, `Layout`, `TerminalSize`), T2 (`Header`/`Toast`/`Footer` are rendered BY the App and passed in as nodes).
- Produces:
  - `Workspace({ size, layout, header, toast, hints, modal, children })` where `header: React.ReactNode`, `toast: { kind: ToastKind; text: string } | null`, `hints: [string, string][]`, `modal: React.ReactNode | null` (when non-null it renders centered INSTEAD of children), `children: React.ReactNode` (the pane row). Total height exactly `size.rows`.
  - `QueueView` new props: `{ snap, scroll, now, height, focused }` — windowed to `height - 3`, accent border/title when focused.

- [ ] **Step 1: Failing tests** — `tests/tuiWorkspace.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { Workspace } from "../src/tui/components/Workspace.js";
import { computeLayout } from "../src/tui/layout.js";

const size = { columns: 100, rows: 20 };

describe("Workspace", () => {
  it("stacks header / body / toast / footer and never exceeds rows", () => {
    const r = render(
      <Workspace
        size={size}
        layout={computeLayout(size.columns, size.rows)}
        header={<Text>HEADER</Text>}
        toast={{ kind: "info", text: "hello toast" }}
        hints={[["q", "quit"]]}
        modal={null}
      >
        <Text>BODY</Text>
      </Workspace>,
    );
    const f = r.lastFrame()!;
    expect(f).toContain("HEADER");
    expect(f).toContain("BODY");
    expect(f).toContain("hello toast");
    expect(f).toContain("quit");
    expect(f.split("\n").length).toBeLessThanOrEqual(size.rows);
  });
  it("tooSmall mode renders guidance instead of the body", () => {
    const f = render(
      <Workspace
        size={{ columns: 40, rows: 10 }}
        layout={computeLayout(40, 10)}
        header={<Text>H</Text>}
        toast={null}
        hints={[]}
        modal={null}
      >
        <Text>NEVER</Text>
      </Workspace>,
    ).lastFrame()!;
    expect(f).toContain("terminal too small");
    expect(f).toContain("60×14");
    expect(f).not.toContain("NEVER");
  });
  it("a modal replaces the body, centered", () => {
    const f = render(
      <Workspace
        size={size}
        layout={computeLayout(size.columns, size.rows)}
        header={<Text>H</Text>}
        toast={null}
        hints={[]}
        modal={<Text>MODAL CONTENT</Text>}
      >
        <Text>HIDDEN BODY</Text>
      </Workspace>,
    ).lastFrame()!;
    expect(f).toContain("MODAL CONTENT");
    expect(f).not.toContain("HIDDEN BODY");
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/tuiWorkspace.test.tsx > /tmp/t7 2>&1; echo "exit: $?"; tail -5 /tmp/t7` → FAIL.

- [ ] **Step 3: Implement** `src/tui/components/Workspace.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { Layout } from "../layout.js";
import type { TerminalSize } from "../useTerminalSize.js";
import type { ToastKind } from "../theme.js";
import { Toast, Footer } from "./Chrome.js";
import { Center } from "./Modal.js";

/** The fullscreen frame: header row, body (panes OR centered modal OR
 * too-small guidance), reserved toast row, footer row. Exactly size.rows tall. */
export function Workspace({
  size,
  layout,
  header,
  toast,
  hints,
  modal,
  children,
}: {
  size: TerminalSize;
  layout: Layout;
  header: React.ReactNode;
  toast: { kind: ToastKind; text: string } | null;
  hints: [string, string][];
  modal: React.ReactNode | null;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      {header}
      <Box flexGrow={1}>
        {layout.mode === "tooSmall" ? (
          <Center>
            <Text dimColor>terminal too small — junco needs at least 60×14</Text>
          </Center>
        ) : modal !== null ? (
          <Center>{modal}</Center>
        ) : (
          children
        )}
      </Box>
      <Toast toast={toast} />
      <Footer hints={hints} />
    </Box>
  );
}
```

`QueueView.tsx` diff — replace the `PAGE` const and signature:

- Delete `const PAGE = 24;` (and its comment).
- Props become `{ snap, scroll, now, height, focused }: { snap: QueueSnapshot | null; scroll: number; now: Date; height: number; focused: boolean }`.
- The outer Box gains `borderColor={focused ? theme.accent : theme.border}` and `height={height}` (import `theme`).
- The title row (add one if only sections exist) becomes `<Text bold color={focused ? theme.accent : undefined}>queue</Text>` as the FIRST row.
- The slice becomes `rows.slice(scroll, scroll + Math.max(1, height - 3))`.
- Update every `QueueView` render in `tests/tuiQueue.test.tsx` to add `height={20} focused={false}`; the scroll test's expectations still hold at height 20 (viewport 17 ≥ the 6-row offset it asserts).

- [ ] **Step 4: Verify green** — `npx vitest run tests/tuiWorkspace.test.tsx tests/tuiQueue.test.tsx > /tmp/t7 2>&1; echo "exit: $?"; tail -5 /tmp/t7` → PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/Workspace.tsx src/tui/components/QueueView.tsx tests/tuiWorkspace.test.tsx tests/tuiQueue.test.tsx
git add src/tui/components/Workspace.tsx src/tui/components/QueueView.tsx tests/tuiWorkspace.test.tsx tests/tuiQueue.test.tsx
git commit -m "feat(tui): workspace frame + queue view re-skin (height-aware, themed)"
```

---

### Task 8: THE SWITCH — App rewire, alt-screen, test migration

This is the big-bang task: `App.tsx` adopts the workspace, the six legacy components are deleted, `dashboardCmd` goes alt-screen, and every existing TUI test is migrated — one atomic commit, suite green.

**Files:**

- Modify: `src/tui/App.tsx` (major), `src/dashboardCmd.ts`, `src/tui/components/CommandOutput.tsx` (gains `height` prop)
- Delete: `src/tui/components/{StatusBar,ShortcutBar,RepoList,IssueTable,IssueDetail,QueueStrip}.tsx`
- Test: migrate `tests/tuiApp.test.tsx`, `tests/tuiInteractive.test.tsx`, `tests/tuiPalette.test.tsx`, `tests/tuiComponents.test.tsx`, `tests/tuiQueue.test.tsx` (QueueStrip block), `tests/dashboardCmd.test.ts`; add the new interaction tests below.

**Interfaces:**

- Consumes: everything from Tasks 1–7 (exact names in their Produces blocks).
- Produces: `AppProps` gains `sizeOverride?: TerminalSize` (tests) — everything else externally unchanged; `dashboardCmd` default render uses `{ exitOnCtrlC: true, alternateScreen: true }`.

**App.tsx changes, in order:**

- [ ] **Step 1: Pane/type groundwork.** `type Pane = 1 | 2 | 3` (1 repos, 2 issues, 3 preview). Replace every `pane === "repos"` with `pane === 1`, `"issues"` with `2`; `setPane("repos"|"issues")` accordingly. New state:

```tsx
const size = useTerminalSize(props.sizeOverride);
const layout = useMemo(() => computeLayout(size.columns, size.rows), [size]);
const [filter, setFilter] = useState("");
const [filtering, setFiltering] = useState(false);
const [toast, setToast] = useState<{ kind: ToastKind; text: string } | null>(null);
const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
const [preview, setPreview] = useState<{
  body: string | null;
  planComment: string | null;
  loading: boolean;
  error: string | null;
}>({ body: null, planComment: null, loading: false, error: null });
const previewCache = useRef(new Map<string, { body: string; planComment: string | null }>());
```

Replace every existing `setToast("msg")` call with `showToast(kind, "msg")` (kind: `"error"` for failures — action errors, watchlist-unreadable warning toast, clone/validate errors; `"info"` for neutral notices; `"success"` for completed dispatch/approve/recycle actions):

```tsx
const showToast = useCallback((kind: ToastKind, text: string) => {
  setToast({ kind, text });
  if (toastTimer.current) clearTimeout(toastTimer.current);
  toastTimer.current = setTimeout(() => setToast(null), 4000);
}, []);
useEffect(
  () => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  },
  [],
);
```

- [ ] **Step 2: Filtered issues + preview autoload.**

```tsx
const filteredIssues = useMemo(
  () => filterIssues(currentIssues, filter, trigger),
  [currentIssues, filter, trigger],
);
```

All selection movement/action code that used `currentIssues` switches to `filteredIssues` (the number-anchored `selectedNum` map already survives re-filtering; the existing `issueIdxSafe` clamp handles shrinkage). Clear the filter on repo switch (`setFilter(""); setFiltering(false);` inside the repo-selection change handler).

```tsx
const previewIssue = pane !== 1 || true ? (filteredIssues[issueIdxSafe] ?? null) : null; // selected issue or null
const previewKey = currentNwo && previewIssue ? `${currentNwo}#${previewIssue.number}` : null;
useEffect(() => {
  if (layout.mode !== "wide" || previewKey === null || !currentNwo || !previewIssue) return;
  const cached = previewCache.current.get(previewKey);
  if (cached) {
    setPreview({ ...cached, loading: false, error: null });
    return;
  }
  setPreview({ body: null, planComment: null, loading: true, error: null });
  let alive = true;
  const t = setTimeout(() => {
    void client.issueDetail(currentNwo, previewIssue.number).then((r) => {
      if (!alive) return;
      if (r.ok) {
        previewCache.current.set(previewKey, r.value);
        setPreview({ ...r.value, loading: false, error: null });
      } else {
        setPreview({ body: null, planComment: null, loading: false, error: r.error });
      }
    });
  }, 300);
  return () => {
    alive = false;
    clearTimeout(t);
  };
}, [previewKey, layout.mode]);
```

(`r` refresh additionally runs `previewCache.current.clear()`.) Simplify the `previewIssue` line to just `filteredIssues[issueIdxSafe] ?? null` — the pane doesn't gate it.

- [ ] **Step 3: Input router.** Inside `useInput`, top of the main-view section, BEFORE other main handling:

```tsx
// `/` filter typing mode captures all printable input.
if (filtering && view === "main") {
  if (key.escape) {
    setFiltering(false);
    setFilter("");
    return;
  }
  if (key.return) {
    setFiltering(false);
    return;
  }
  if (key.backspace || key.delete) {
    setFilter((f) => f.slice(0, -1));
    return;
  }
  if (input && !key.ctrl && !key.meta) {
    setFilter((f) => f + input);
    return;
  }
  return;
}
```

Then add to main-view handling (keeping all existing keys):

- `/` → `setFiltering(true); setPane(2); return;`
- `1` → `setPane(1)`; `2` → `setPane(2)`; `3` → `if (layout.mode === "wide") setPane(3)`.
- `g`/`G` → pane 1: `setRepoIdx(0)` / `setRepoIdx(repoMappings.length - 1)`; pane 2: move anchor to first/last of `filteredIssues`.
- `enter` on pane 2 → `layout.mode === "wide" ? setPane(3) : openDetail()` (openDetail unchanged, drives the medium detail view).
- pane 3 focused: `j`/`]`/down → `setScroll((s) => s + 1)`; `k`/`[`/up → `setScroll((s) => Math.max(0, s - 1))`; `o` → openBrowser; `esc`/`enter` → `setPane(2)`.
- `esc` on pane 2 with an active filter (not typing) → `setFilter("")`.
- tab cycles `1→2→(3 if wide)→1`; `h`/`l` move left/right clamped.
- Any-keystroke toast dismissal keeps working: the existing `if (toast) setToast(null)` line stays (also clear `toastTimer`).

- [ ] **Step 4: Render.** Replace App's whole return with:

```tsx
const hints = hintsFor(view as HintView, pane, layout.mode, filtering);
const listHeight = layout.bodyRows;
const modal =
  view === "help" ? (
    <HelpModal view="main" pane={pane} mode={layout.mode} trigger={trigger} />
  ) : view === "palette" ? (
    <Modal title="run a junco command" minWidth={64}>
      <CommandPalette {...paletteProps} />
    </Modal>
  ) : view === "addRepo" ? (
    <Modal title="add repo to watchlist" minWidth={54}>
      <AddRepoForm {...addRepoProps} />
    </Modal>
  ) : null;

return (
  <Workspace
    size={size}
    layout={layout}
    header={
      <Header
        repoNwo={currentNwo}
        daemonUp={health === null ? null : health.up}
        uptimeSeconds={health?.uptimeSeconds ?? null}
        queueRunning={queueSnap?.running.length ?? 0}
        queueWaiting={queueSnap?.waiting.length ?? 0}
        watchlistError={watchlistError}
        now={queueNow}
      />
    }
    toast={toast}
    hints={hints}
    modal={modal}
  >
    <Rail
      repos={repoRows}
      selected={repoIdxSafe}
      focused={view === "main" && pane === 1}
      queue={queueSnap}
      width={layout.railWidth}
      height={listHeight}
    />
    {view === "queue" ? (
      <QueueView snap={queueSnap} scroll={scroll} now={queueNow} height={listHeight} focused />
    ) : view === "cmdOutput" && cmd ? (
      <CommandOutput
        title={cmd.title}
        running={cmd.running}
        elapsedS={cmdElapsed}
        output={cmd.output}
        scroll={scroll}
        exitCode={cmd.exitCode}
        timedOut={cmd.timedOut}
        height={listHeight}
      />
    ) : view === "detail" && detail ? (
      <Preview
        issue={detail.issue}
        trigger={trigger}
        body={detail.body}
        planComment={detail.planComment}
        loading={detail.loading}
        error={null}
        scroll={scroll}
        focused
        height={listHeight}
      />
    ) : (
      <IssueList
        issues={filteredIssues}
        trigger={trigger}
        selected={issueIdxSafe}
        focused={view === "main" && pane === 2}
        refreshing={refreshing}
        filter={filter}
        filtering={filtering}
        height={listHeight}
        now={queueNow}
      />
    )}
    {layout.mode === "wide" && view === "main" && (
      <Preview
        issue={previewIssue}
        trigger={trigger}
        body={preview.body}
        planComment={preview.planComment}
        loading={preview.loading}
        error={preview.error}
        scroll={scroll}
        focused={pane === 3}
        height={listHeight}
        width={layout.previewWidth}
        paneNumber
      />
    )}
  </Workspace>
);
```

(`paletteProps`/`addRepoProps` are the exact prop sets currently passed — unchanged.) `AppProps` gains `sizeOverride?: TerminalSize`. Delete the now-unused imports and the six legacy component files. `CommandOutput.tsx` gains a `height: number` prop and windows its output lines with it (replace its fixed visible-line constant with `Math.max(1, height - 5)`, keeping its header/footer rows).

- [ ] **Step 5: dashboardCmd alt-screen.** In `src/dashboardCmd.ts`, the default renderFn becomes:

```ts
const renderFn =
  deps.renderFn ??
  ((el: React.ReactElement) => ink.render(el, { exitOnCtrlC: true, alternateScreen: true }));
```

(Comment: alt buffer — fullscreen, zero scrollback pollution, terminal restored on exit; a no-op when non-interactive, and the TTY guard exits before this anyway.)

- [ ] **Step 6: Migrate the test files.** Rules: default `renderApp` size is **medium** (inject `sizeOverride={{ columns: 100, rows: 30 }}` so legacy enter-opens-detail flows survive); add wide-mode tests at `{ columns: 130, rows: 30 }`. Every wait stays a bounded until-loop. Per file:

| File                      | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tuiApp.test.tsx`         | `renderApp` passes `sizeOverride` (medium). String updates: `"GitHub repositories"` → `"1 repos"`; `"issues"` title → `"2 issues"`; shortcut assertions (`"t queue"` etc.) still hold via Footer; queue-strip assertions (`"queue — 1 running · 1 waiting"`, `"#46 exec"`) move to rail equivalents (`"queue"`, `"#46 exec"`, `"1 waiting"` — waiting count is 1 in `QUEUE_SNAP`). Toast tests: failures now auto-expire — assert presence via until-loop without asserting persistence. NEW tests (medium): `/` filter narrows the list + esc clears; `1`/`2` pane jumps move the accent title; `g`/`G` jump. NEW tests (wide, 130 cols): `"3 preview"` renders; selecting an issue autoloads the body (fake client `issueDetail` → until-loop for `"the body"`); `enter` focuses pane 3 (footer shows scroll hints); `3` is inert at medium width. |
| `tuiInteractive.test.tsx` | Same `sizeOverride` medium + same title-string updates; detail-flow tests unchanged in spirit (enter still opens detail at medium).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tuiPalette.test.tsx`     | Palette/output flows unchanged; the palette title now comes from the Modal — assert `"run a junco command"` still present (Modal title).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tuiComponents.test.tsx`  | Delete describe-blocks for StatusBar/ShortcutBar/RepoList/IssueTable/IssueDetail/QueueStrip (each already superseded by tuiChrome/tuiRail/tuiIssueList/tuiPreview/tuiWorkspace). Keep whatever tests target still-living components (Spinner, TextField); move them if the file empties otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tuiQueue.test.tsx`       | Delete the QueueStrip describe-block (component gone; rail card covered in tuiRail). QueueView tests already migrated in Task 7. Keep queueFmt tests untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `dashboardCmd.test.ts`    | The lazy-loading-discipline test: keep; add an assertion that the source contains `alternateScreen: true`. TTY/disabled-guard tests unchanged (renderFn fake bypasses ink).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Representative new wide-mode test (add to `tuiApp.test.tsx`):

```tsx
it("wide mode: preview pane autoloads the selected issue's body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "junco-tui-wide-"));
  const { client } = makeClient({ "acme/api": [rawIssue] });
  const r = render(
    <App
      client={client}
      trigger="junco"
      configRepos={[{ nwo: "acme/api", path: "/c/api" }]}
      watchlistFile={join(dir, "wl.json")}
      configPath="/x/config.toml"
      clonesDir={CLONES_DIR}
      issuePollMs={999999}
      healthPollMs={999999}
      queuePollMs={999999}
      queueFn={async () => QUEUE_SNAP}
      sizeOverride={{ columns: 130, rows: 30 }}
      onExit={() => {}}
    />,
  );
  await until(() => (r.lastFrame() ?? "").includes("3 preview"));
  await until(() => (r.lastFrame() ?? "").includes("the body")); // autoload (debounce 300ms < until budget)
});
```

- [ ] **Step 7: Full suite** — `npx vitest run > /tmp/t8 2>&1; echo "exit: $?"; tail -8 /tmp/t8` → exit 0. Then `npm run lint && npm run format:check && npm run build` → all exit 0.

- [ ] **Step 8: Commit**

```bash
npx prettier --write src/tui/App.tsx src/dashboardCmd.ts src/tui/components/CommandOutput.tsx tests/tuiApp.test.tsx tests/tuiInteractive.test.tsx tests/tuiPalette.test.tsx tests/tuiComponents.test.tsx tests/tuiQueue.test.tsx tests/dashboardCmd.test.ts
git add -A src/tui src/dashboardCmd.ts tests
git commit -m "feat(dashboard): fullscreen workspace — alt-screen, responsive panes, filter, themed"
```

---

### Task 9: Docs + full gate + smoke checklist

**Files:**

- Modify: `README.md` (dashboard section: rewrite the key table, describe the workspace/preview/alt-screen), `ARCHITECTURE.md` (`tui/` row)

**Interfaces:** none — documents Tasks 1–8 as shipped. Before writing, read `Chrome.tsx`/`App.tsx` `hintsFor` so every documented key matches shipped behavior. Stack-agnostic wording only.

- [ ] **Step 1: README.** In the dashboard section: add a sentence up front — "The dashboard runs fullscreen in the terminal's alternate buffer (like vim or htop): it uses your whole window, adapts its layout to the terminal size (a side-by-side preview pane appears at ≥110 columns), and restores your terminal exactly on exit." Update the key table: add rows for `1/2/3` (jump pane), `/` (filter issues; esc clears), `g/G` (first/last), update `enter` (wide: focus preview · narrower: open detail), keep every existing row otherwise. Mention the queue card now lives in the left rail (the `t` view is unchanged).

- [ ] **Step 2: ARCHITECTURE.** `tui/` row becomes: `Ink dashboard (fullscreen workspace): theme/layout/window foundations, pure state derivation, gh client seam, queue snapshot, components, App.`

- [ ] **Step 3: Full gate** — `npm run lint && npm run format:check && npm run build && npx vitest run > /tmp/gate 2>&1; echo "exit: $?"; tail -5 /tmp/gate` → exit 0.

- [ ] **Step 4: Manual smoke checklist** (real terminal, read-only — do NOT dispatch/approve on live issues): run `node dist/cli.js dashboard` from the repo root and verify: (a) alt-screen entered and terminal restored on `q`; (b) resize wide↔narrow live-reflows 3↔2 panes; (c) shrink below 60 cols → "terminal too small", grow back → recovers; (d) `/` filter narrows + esc clears; (e) `1/2/3` focus styling moves; (f) preview autoloads on selection (wide); (g) `?` help, `:` palette, `t` queue all render centered/in-slot; (h) no frame duplication in scrollback after exit. Record the results in the commit message body (one line per check).

- [ ] **Step 5: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs: fullscreen dashboard workspace — layout, keys, alt-screen"
```
