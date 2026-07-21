# TUI Dashboard Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declutter the dashboard (digit labels, daemon dot, ↻ stamp), freeze column geometry, add a primitives component kit (badges, gauges, sparklines, rules, scrollbars, stat rows, buttons, table headers), fill the top bar with live metrics, and highlight bot-authored issues/PRs.

**Architecture:** A new `src/tui/components/primitives/` kit of pure, themed Ink components (each with an exported pure text/segment builder for ANSI-free structural tests), then surface-by-surface adoption: header, lists, queue, daemon/repo panels, reserved third slot, confirm modal. New header chips read the already-polled `QueueStats` (`localCheap.queue.stats`) — zero new fetches.

**Tech Stack:** TypeScript strict ESM (NodeNext, Node ≥ 22.19), Ink 5 + ink-testing-library, vitest. Spec: `docs/superpowers/specs/2026-07-20-tui-dashboard-polish-design.md`.

## Global Constraints

- **No new dependencies** (`@inkjs/ui` evaluated and declined in the spec). Deps are exact-pinned.
- **No daemon/health endpoint changes** — the TUI consumes existing fields only.
- Every frame stays within its height budget (Ink duplicate-redraw hazard); rows never wrap — fixed cells are `flexShrink={0}`, exactly one flexible cell per row.
- NO_COLOR degradation: every primitive stays legible colorless (glyph pairs, bold, padding — never color alone).
- Suite green at every commit: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` (never pipe vitest into a filter — the exit-code trap).
- After shared-type changes run `npx tsc --noEmit -p tsconfig.eslint.json` (vitest does not type-check; ~57 pre-existing errors in that sweep are ignorable noise — look only for NEW errors in touched files).
- Prettier may reformat between read and edit: re-read before editing, `npx prettier --write` touched files before committing.
- Ink/TUI tests: never assert one fixed timeout tick — loop-until-condition (`tests/helpers/until.ts`) with bounded retry.
- No AI attribution in commits, conventional commit messages, TDD (watch each test fail first).

## File Map

| File                                                     | Role                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `src/tui/components/primitives/Badge.tsx` (new)          | state pill + `badgeText`                                     |
| `src/tui/components/primitives/Rule.tsx` (new)           | titled divider + `ruleText`                                  |
| `src/tui/components/primitives/StatRow.tsx` (new)        | aligned key/value line                                       |
| `src/tui/components/primitives/Gauge.tsx` (new)          | ▰▱ fill bar + `gaugeText`                                    |
| `src/tui/components/primitives/Sparkline.tsx` (new)      | fmtSpark wrapper                                             |
| `src/tui/components/primitives/Scrollbar.tsx` (new)      | track/thumb column + `scrollbarCells`                        |
| `src/tui/components/primitives/Button.tsx` (new)         | clickable `[ y confirm ]` chip                               |
| `src/tui/components/primitives/TableHeader.tsx` (new)    | column-header strip + `Column` type                          |
| `src/tui/components/ActivityCard.tsx` (new)              | pane-3 stats card + `ReservedNote`                           |
| `src/botIdentity.ts` (new)                               | `resolveBotLogin`                                            |
| `src/tui/components/Chrome.tsx`                          | Header: crumbs, chip groups, stats; drop ↻/dot               |
| `src/tui/components/{IssueList,PrList}.tsx`              | columnar rows + header strip + pills                         |
| `src/tui/components/QueueView.tsx`                       | strip headers + running-row gauge                            |
| `src/tui/components/sections.tsx`                        | daemon badge text, DaemonSection restyle                     |
| `src/tui/components/RepoDetail.tsx`                      | Rule/StatRow restyle + scrollbar                             |
| `src/tui/components/UnifiedRail.tsx`                     | title, Rule separator                                        |
| `src/tui/components/HelpModal.tsx`                       | drop 1/2/3 row, bot legend                                   |
| `src/tui/components/{Preview,CommandOutput,LogView}.tsx` | scrollbars                                                   |
| `src/tui/App.tsx`                                        | hotkeys, crumbs, reserved pane 3, confirm buttons, bot login |
| `src/tui/{state,prState}.ts`                             | `MAX_*_BADGE_LEN`, `DashIssue.author`                        |
| `src/tui/ghClient.ts`                                    | issue `author` fetch                                         |
| `src/tui/queueSnapshot.ts`                               | `taskTimeoutSeconds`                                         |
| `src/tui/geometry.ts`                                    | `listRowsHeight` −1 (header strip)                           |

---

### Task 1: Badge, Rule, StatRow primitives

**Files:**

- Create: `src/tui/components/primitives/Badge.tsx`, `src/tui/components/primitives/Rule.tsx`, `src/tui/components/primitives/StatRow.tsx`
- Test: `tests/tuiPrimitives.test.tsx` (new)

**Interfaces:**

- Consumes: `theme` from `src/tui/theme.ts` (not needed by these three, but the test file imports later primitives too — keep it one suite).
- Produces: `badgeText(label: string, padTo?: number): string`; `Badge({label, color, padTo})`; `ruleText(title: string | null, width: number): string`; `Rule({title, width})`; `StatRow({label, value, labelWidth, color?, hint?})`.

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/tuiPrimitives.test.tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Badge, badgeText } from "../src/tui/components/primitives/Badge.js";
import { Rule, ruleText } from "../src/tui/components/primitives/Rule.js";
import { StatRow } from "../src/tui/components/primitives/StatRow.js";

describe("badgeText", () => {
  it("wraps the label in one pad space each side", () => {
    expect(badgeText("done")).toBe(" done ");
  });
  it("pads the label to padTo so pill columns align", () => {
    expect(badgeText("done", 10)).toBe(" done       ");
    expect(badgeText("plan-ready", 10)).toBe(" plan-ready ");
  });
  it("renders the padded label (frame strips ANSI)", () => {
    const { lastFrame } = render(<Badge label="failed" color="red" padTo={8} />);
    expect(lastFrame()).toContain(" failed ");
  });
});

describe("ruleText", () => {
  it("pads a titled rule to the width", () => {
    expect(ruleText("system", 16)).toBe("── system ──────");
    expect(ruleText("system", 16)).toHaveLength(16);
  });
  it("bare line when title is null", () => {
    expect(ruleText(null, 5)).toBe("─────");
  });
  it("never goes negative on a too-long title", () => {
    expect(ruleText("longtitle", 4)).toBe("── longtitle ");
  });
  it("Rule renders the same text", () => {
    const { lastFrame } = render(<Rule title="system" width={16} />);
    expect(lastFrame()).toBe("── system ──────");
  });
});

describe("StatRow", () => {
  it("pads the label to labelWidth before the value", () => {
    const { lastFrame } = render(<StatRow label="state" value="up 2h" labelWidth={10} />);
    expect(lastFrame()).toBe("state     up 2h");
  });
  it("appends the hint after a space", () => {
    const { lastFrame } = render(
      <StatRow label="state" value="up 2h" labelWidth={8} hint="pid 42" />,
    );
    expect(lastFrame()).toBe("state   up 2h pid 42");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiPrimitives.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, "Failed to load … primitives/Badge.js" (module not found).

- [ ] **Step 3: Implement the three primitives**

```tsx
// src/tui/components/primitives/Badge.tsx
import React from "react";
import { Text } from "ink";

/** Pill text: one pad space each side; `padTo` pads the label itself so a
 * column of pills shares one width (longest badge in the meta table). */
export function badgeText(label: string, padTo?: number): string {
  return ` ${padTo !== undefined ? label.padEnd(padTo) : label} `;
}

/** State pill: label on a semantic background, black text for contrast.
 * NO_COLOR strips the background (chalk) and keeps the padded label — same
 * width, still legible. */
export function Badge({
  label,
  color,
  padTo,
}: {
  label: string;
  /** Semantic color name or hex — the pill background. */
  color: string;
  padTo?: number;
}): React.JSX.Element {
  return (
    <Text backgroundColor={color} color="black">
      {badgeText(label, padTo)}
    </Text>
  );
}
```

```tsx
// src/tui/components/primitives/Rule.tsx
import React from "react";
import { Text } from "ink";

/** Plain text of a titled divider: `── title ────…` padded to `width`. */
export function ruleText(title: string | null, width: number): string {
  if (title === null) return "─".repeat(Math.max(0, width));
  const head = `── ${title} `;
  return head + "─".repeat(Math.max(0, width - head.length));
}

/** Titled divider: dim line, bold title. */
export function Rule({ title, width }: { title: string | null; width: number }): React.JSX.Element {
  if (title === null) return <Text dimColor>{ruleText(null, width)}</Text>;
  const head = `── ${title} `;
  return (
    <Text>
      <Text dimColor>{"── "}</Text>
      <Text bold>{title}</Text>
      <Text dimColor>{" " + "─".repeat(Math.max(0, width - head.length))}</Text>
    </Text>
  );
}
```

```tsx
// src/tui/components/primitives/StatRow.tsx
import React from "react";
import { Text } from "ink";

/** Aligned key/value line for detail panels: dim fixed-width label, bold
 * value (optionally colored), dim hint suffix. One per stat — panels build
 * grids by stacking rows with one shared labelWidth. */
export function StatRow({
  label,
  value,
  labelWidth,
  color,
  hint,
}: {
  label: string;
  value: string;
  labelWidth: number;
  color?: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{label.padEnd(labelWidth)}</Text>
      <Text bold color={color}>
        {value}
      </Text>
      {hint !== undefined ? <Text dimColor> {hint}</Text> : null}
    </Text>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/tuiPrimitives.test.tsx > /tmp/out 2>&1; echo "exit: $?"`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/primitives tests/tuiPrimitives.test.tsx
git add src/tui/components/primitives tests/tuiPrimitives.test.tsx
git commit -m "feat(tui): Badge, Rule, StatRow primitives"
```

---

### Task 2: Gauge and Sparkline primitives

**Files:**

- Create: `src/tui/components/primitives/Gauge.tsx`, `src/tui/components/primitives/Sparkline.tsx`
- Test: `tests/tuiPrimitives.test.tsx` (append)

**Interfaces:**

- Consumes: `fmtSpark(values: number[]): string` from `src/tui/queueFmt.ts`.
- Produces: `gaugeText(value: number | null, max: number, width: number): string`; `Gauge({value, max, width, color?, label?})`; `Sparkline({values, color?})`.

- [ ] **Step 1: Append the failing tests**

```tsx
// tests/tuiPrimitives.test.tsx (append; add imports)
import { Gauge, gaugeText } from "../src/tui/components/primitives/Gauge.js";
import { Sparkline } from "../src/tui/components/primitives/Sparkline.js";

describe("gaugeText", () => {
  it("fills proportionally", () => {
    expect(gaugeText(5, 10, 10)).toBe("▰▰▰▰▰▱▱▱▱▱");
  });
  it("clamps overflow to full", () => {
    expect(gaugeText(99, 10, 8)).toBe("▰▰▰▰▰▰▰▰");
  });
  it("null value renders all track", () => {
    expect(gaugeText(null, 10, 6)).toBe("▱▱▱▱▱▱");
  });
  it("zero/negative max renders all track", () => {
    expect(gaugeText(3, 0, 6)).toBe("▱▱▱▱▱▱");
  });
  it("Gauge appends the label after the bar", () => {
    const { lastFrame } = render(<Gauge value={5} max={10} width={4} label="23m / 45m" />);
    expect(lastFrame()).toBe("▰▰▱▱ 23m / 45m");
  });
});

describe("Sparkline", () => {
  it("renders fmtSpark bars", () => {
    const { lastFrame } = render(<Sparkline values={[0, 1, 2, 4]} />);
    expect(lastFrame()).toBe("▁▂▄█");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiPrimitives.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, module not found `primitives/Gauge.js`.

- [ ] **Step 3: Implement**

```tsx
// src/tui/components/primitives/Gauge.tsx
import React from "react";
import { Text } from "ink";

/** ▰▱ fill string; null value or non-positive max → all track. */
export function gaugeText(value: number | null, max: number, width: number): string {
  if (value === null || max <= 0) return "▱".repeat(Math.max(0, width));
  const filled = Math.min(width, Math.max(0, Math.round((value / max) * width)));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/** Determinate fill bar. The ▰/▱ glyph pair carries the reading colorlessly
 * (NO_COLOR-safe); `label` renders dim after the bar. */
export function Gauge({
  value,
  max,
  width,
  color,
  label,
}: {
  value: number | null;
  max: number;
  width: number;
  color?: string;
  label?: string;
}): React.JSX.Element {
  return (
    <Text>
      <Text color={value === null ? undefined : color} dimColor={value === null}>
        {gaugeText(value, max, width)}
      </Text>
      {label !== undefined ? <Text dimColor> {label}</Text> : null}
    </Text>
  );
}
```

```tsx
// src/tui/components/primitives/Sparkline.tsx
import React from "react";
import { Text } from "ink";
import { fmtSpark } from "../../queueFmt.js";

/** Per-value bar chart (▁▂▃▄▅▆▇█ via fmtSpark). Dim when every value is
 * zero — an empty week recedes instead of glowing. */
export function Sparkline({
  values,
  color,
}: {
  values: number[];
  color?: string;
}): React.JSX.Element {
  const empty = values.every((v) => v <= 0);
  return (
    <Text color={empty ? undefined : color} dimColor={empty}>
      {fmtSpark(values)}
    </Text>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/tuiPrimitives.test.tsx > /tmp/out 2>&1; echo "exit: $?"`
Expected: exit 0. (If the Sparkline expectation differs, check `fmtSpark`'s rounding in `src/tui/queueFmt.ts:92` — the test values map 0→▁, 1→▂, 2→▄, 4→█ under `round(v/max*7)` with max 4; fix the EXPECTATION only if your arithmetic disagrees, never the primitive.)

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/primitives tests/tuiPrimitives.test.tsx
git add -A src/tui/components/primitives tests/tuiPrimitives.test.tsx
git commit -m "feat(tui): Gauge and Sparkline primitives"
```

---

### Task 3: Scrollbar and Button primitives

**Files:**

- Create: `src/tui/components/primitives/Scrollbar.tsx`, `src/tui/components/primitives/Button.tsx`
- Test: `tests/tuiPrimitives.test.tsx` (append)

**Interfaces:**

- Consumes: `theme`, `ClickableBox` (`src/tui/ClickableBox.ts` — import path `../../ClickableBox.js`).
- Produces: `scrollbarCells(offset, viewport, total, height): string[]`; `Scrollbar({offset, viewport, total, height}): JSX | null`; `ButtonTone = "danger" | "neutral" | "primary"`; `Button({keyHint, label, tone, onPress?})`.

- [ ] **Step 1: Append the failing tests**

```tsx
// tests/tuiPrimitives.test.tsx (append; add imports)
import { Scrollbar, scrollbarCells } from "../src/tui/components/primitives/Scrollbar.js";
import { Button } from "../src/tui/components/primitives/Button.js";

describe("scrollbarCells", () => {
  it("empty when content fits", () => {
    expect(scrollbarCells(0, 10, 8, 10)).toEqual([]);
  });
  it("thumb at top for offset 0", () => {
    expect(scrollbarCells(0, 5, 10, 4)).toEqual(["█", "█", "│", "│"]);
  });
  it("thumb at bottom for max offset", () => {
    expect(scrollbarCells(5, 5, 10, 4)).toEqual(["│", "│", "█", "█"]);
  });
  it("thumb never shorter than one cell", () => {
    const cells = scrollbarCells(0, 2, 200, 6);
    expect(cells.filter((c) => c === "█")).toHaveLength(1);
  });
  it("Scrollbar renders null when content fits", () => {
    const { lastFrame } = render(<Scrollbar offset={0} viewport={10} total={5} height={10} />);
    expect(lastFrame()).toBe("");
  });
});

describe("Button", () => {
  it("neutral tone renders bracketed key + label", () => {
    const { lastFrame } = render(<Button keyHint="esc" label="cancel" tone="neutral" />);
    expect(lastFrame()).toBe("[ esc cancel ]");
  });
  it("primary tone renders padded key + label (pill)", () => {
    const { lastFrame } = render(<Button keyHint="y" label="confirm" tone="primary" />);
    expect(lastFrame()).toBe(" y confirm ");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiPrimitives.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, module not found `primitives/Scrollbar.js`.

- [ ] **Step 3: Implement**

```tsx
// src/tui/components/primitives/Scrollbar.tsx
import React from "react";
import { Box, Text } from "ink";

/** Track/thumb glyph per row; empty array when everything fits (no bar). */
export function scrollbarCells(
  offset: number,
  viewport: number,
  total: number,
  height: number,
): string[] {
  if (total <= viewport || height <= 0) return [];
  const thumbLen = Math.max(1, Math.round((viewport / total) * height));
  const maxStart = height - thumbLen;
  const maxOffset = total - viewport;
  const thumbStart =
    maxOffset <= 0 ? 0 : Math.min(maxStart, Math.round((offset / maxOffset) * maxStart));
  return Array.from({ length: height }, (_, i) =>
    i >= thumbStart && i < thumbStart + thumbLen ? "█" : "│",
  );
}

/** Right-edge vertical scrollbar; renders nothing when content fits. */
export function Scrollbar({
  offset,
  viewport,
  total,
  height,
}: {
  offset: number;
  viewport: number;
  total: number;
  height: number;
}): React.JSX.Element | null {
  const cells = scrollbarCells(offset, viewport, total, height);
  if (cells.length === 0) return null;
  return (
    <Box flexDirection="column" flexShrink={0} width={1}>
      {cells.map((c, i) => (
        <Text key={i} dimColor={c === "│"}>
          {c}
        </Text>
      ))}
    </Box>
  );
}
```

```tsx
// src/tui/components/primitives/Button.tsx
import React from "react";
import { Text } from "ink";
import { theme } from "../../theme.js";
import { ClickableBox } from "../../ClickableBox.js";

export type ButtonTone = "danger" | "neutral" | "primary";

/** Clickable dialog button. Toned buttons are pills (colored background,
 * black text); neutral is dim brackets with the key in accent. NO_COLOR keeps
 * the bracket/pad structure and bold key. */
export function Button({
  keyHint,
  label,
  tone,
  onPress,
}: {
  keyHint: string;
  label: string;
  tone: ButtonTone;
  onPress?: () => void;
}): React.JSX.Element {
  const bg = tone === "danger" ? theme.error : tone === "primary" ? theme.accent : undefined;
  const body =
    bg !== undefined ? (
      <Text backgroundColor={bg} color="black">
        {" "}
        <Text bold>{keyHint}</Text> {label}{" "}
      </Text>
    ) : (
      <Text>
        <Text dimColor>[ </Text>
        <Text bold color={theme.accent}>
          {keyHint}
        </Text>
        <Text> {label}</Text>
        <Text dimColor> ]</Text>
      </Text>
    );
  return (
    <ClickableBox onPress={onPress} hoverBg={theme.hoverBg}>
      {body}
    </ClickableBox>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/tuiPrimitives.test.tsx > /tmp/out 2>&1; echo "exit: $?"`
Expected: exit 0. (Thumb-geometry expectations use `round`; if an assertion is off by one cell, recompute by hand against `scrollbarCells` and fix the EXPECTATION only when your arithmetic confirms it.)

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/primitives tests/tuiPrimitives.test.tsx
git add -A src/tui/components/primitives tests/tuiPrimitives.test.tsx
git commit -m "feat(tui): Scrollbar and Button primitives"
```

---

### Task 4: TableHeader primitive

**Files:**

- Create: `src/tui/components/primitives/TableHeader.tsx`
- Test: `tests/tuiPrimitives.test.tsx` (append)

**Interfaces:**

- Produces: `interface Column { label: string; width: number | "flex"; align?: "left" | "right" }`; `headerCell(col: Column): string`; `TableHeader({columns: Column[]})`. Data rows in Tasks 8–9 mirror these widths with `gap={1}` boxes.

- [ ] **Step 1: Append the failing tests**

```tsx
// tests/tuiPrimitives.test.tsx (append; add import)
import { TableHeader, headerCell } from "../src/tui/components/primitives/TableHeader.js";

describe("TableHeader", () => {
  it("headerCell pads left/right per align", () => {
    expect(headerCell({ label: "#", width: 5, align: "right" })).toBe("    #");
    expect(headerCell({ label: "age", width: 5 })).toBe("age  ");
    expect(headerCell({ label: "title", width: "flex" })).toBe("title");
  });
  it("renders every label in one row", () => {
    const { lastFrame } = render(
      <TableHeader
        columns={[
          { label: "", width: 2 },
          { label: "#", width: 5, align: "right" },
          { label: "title", width: "flex" },
          { label: "age", width: 4, align: "right" },
        ]}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("#");
    expect(f).toContain("title");
    expect(f).toContain("age");
    expect(f.split("\n")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiPrimitives.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, module not found.

- [ ] **Step 3: Implement**

```tsx
// src/tui/components/primitives/TableHeader.tsx
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme.js";

export interface Column {
  label: string;
  /** Fixed cell width, or "flex" for the one growing column. */
  width: number | "flex";
  align?: "left" | "right";
}

/** Padded label for one column (pure, for structural tests). */
export function headerCell(col: Column): string {
  if (col.width === "flex") return col.label;
  return col.align === "right" ? col.label.padStart(col.width) : col.label.padEnd(col.width);
}

/** Column-header strip: bold accent labels on the hover background, cells
 * aligned to the same widths the data rows use (gap 1, mirrored). NO_COLOR →
 * bold text only. */
export function TableHeader({ columns }: { columns: Column[] }): React.JSX.Element {
  return (
    <Box width="100%" gap={1} backgroundColor={theme.hoverBg}>
      {columns.map((c, i) =>
        c.width === "flex" ? (
          <Box key={i} flexGrow={1} minWidth={0}>
            <Text bold color={theme.accent} wrap="truncate">
              {headerCell(c)}
            </Text>
          </Box>
        ) : (
          <Box key={i} flexShrink={0} width={c.width}>
            <Text bold color={theme.accent}>
              {headerCell(c)}
            </Text>
          </Box>
        ),
      )}
    </Box>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/tuiPrimitives.test.tsx > /tmp/out 2>&1; echo "exit: $?"`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/primitives tests/tuiPrimitives.test.tsx
git add -A src/tui/components/primitives tests/tuiPrimitives.test.tsx
git commit -m "feat(tui): TableHeader primitive"
```

---

### Task 5: Declutter — titles, digit hotkeys, daemon dots

**Files:**

- Modify: `src/tui/components/UnifiedRail.tsx:83-85`, `src/tui/components/IssueList.tsx:78-79`, `src/tui/components/PrList.tsx:75-76`, `src/tui/App.tsx:606-608` (pane3Title), `src/tui/App.tsx:2505-2510` (digit branches), `src/tui/components/HelpModal.tsx:76`, `src/tui/components/Chrome.tsx:69-74` + `:122` (daemon chip), `src/tui/components/sections.tsx:44-45` (rail badge)
- Test: `tests/tuiDeclutter.test.tsx` (new) + retargeted existing suites

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/tuiDeclutter.test.tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Header } from "../src/tui/components/Chrome.js";
import { sectionBadge } from "../src/tui/components/sections.js";
import type { LocalCheap } from "../src/tui/localSnapshot.js";

const health = {
  up: true,
  uptimeSeconds: 7980,
  lastBridgeSweepAt: null,
  ticketsBridged: null,
  tasksProcessed: null,
  tasksSucceeded: 3,
  tasksFailed: 0,
  lastTaskStatus: null,
  lastTaskAt: null,
  totalTokensOut: null,
  bridgeErrors: null,
};

const headerProps = {
  crumbs: ["acme/site"],
  health,
  reviewCount: 0,
  now: new Date("2026-07-20T12:00:00Z"),
  mode: "wide" as const,
  queueRunning: 0,
  queueWaiting: 0,
  watchlistError: null,
  outboxDepth: 0,
  prAttention: 0,
  prFailing: false,
  stats: null,
  runningIds: [] as string[],
};

describe("daemon chip (dot removed)", () => {
  it("shows text-only up state", () => {
    const { lastFrame } = render(<Header {...headerProps} />);
    expect(lastFrame()).toContain("daemon up 2h13m");
    expect(lastFrame()).not.toContain("●");
    expect(lastFrame()).not.toContain("○");
  });
  it("shows daemon down when down", () => {
    const { lastFrame } = render(<Header {...headerProps} health={{ ...health, up: false }} />);
    expect(lastFrame()).toContain("daemon down");
  });
});

describe("rail daemon badge (dot removed)", () => {
  const cheap = {
    daemon: { up: true },
    queue: { running: [] },
    outbox: { depth: 0 },
  } as unknown as LocalCheap;
  it("up/down text instead of dots", () => {
    expect(sectionBadge("daemon", cheap, null)).toBe("up");
    expect(
      sectionBadge("daemon", { ...cheap, daemon: { up: false } } as unknown as LocalCheap, null),
    ).toBe("down");
  });
});
```

Note: this test builds `Header` with its POST-task props (`crumbs`, `stats`, `runningIds`, no `repoNwo`/`refreshedAt`/`updateLatest` changes yet beyond renames). Task 7 finishes the chip work; this task only renames `repoNwo` → `crumbs` (single-element rendering, no ▸ yet), removes the dot, and removes the ↻ chip + `refreshedAt` prop.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiDeclutter.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -8 /tmp/out`
Expected: exit 1 — type error / `daemon ●` in frame.

- [ ] **Step 3: Implement the declutter sweep**

1. `UnifiedRail.tsx:84`: `1 repos` → `repos`.
2. `IssueList.tsx:79`: `2 issues · {issues.length}` → `issues · {issues.length}`.
3. `PrList.tsx:76`: default title `` `p pull requests · ${prs.length}` `` → `` `pull requests · ${prs.length}` ``.
4. `App.tsx:608`: ``currentNwo ? `3 PRs · ${truncateNwoStart(currentNwo)}` : "3 PRs"`` → ``currentNwo ? `PRs · ${truncateNwoStart(currentNwo)}` : "PRs"``.
5. `App.tsx:2505-2510`: delete the three `if (input === "1"|"2"|"3")` branches (keep the `maxPane`/tab/h/l/`i` block that follows).
6. `HelpModal.tsx:76`: delete the `["1/2/3", "jump pane directly …"]` row.
7. `Chrome.tsx` Header: rename prop `repoNwo: string | null` → `crumbs: string[]` (render `crumbs.join(" ▸ ")` for now in the same bold truncating Text; Task 7 makes the separator dim). Replace the daemon chip block:

```tsx
const daemon =
  daemonUp === null
    ? "daemon …"
    : daemonUp
      ? `daemon${fmtUp(health?.uptimeSeconds ?? null)}`
      : "daemon down";
```

with the chip `<Text color={daemonUp ? theme.success : theme.warn}>{daemon}</Text>` unchanged. `fmtUp` already renders ` up 2h13m` with a leading space. Delete the `refreshedAt` prop, its chip (`↻ …`), and its JSDoc. 8. `sections.tsx:45`: `return cheap.daemon.up ? "●" : "○";` → `return cheap.daemon.up ? "up" : "down";`. 9. `App.tsx` Header call site (~2707): pass `crumbs={[currentNwo ?? "no repo"]}` and delete `refreshedAt={refreshedAt}`. Add placeholder props `stats={null}` `runningIds={[]}` ONLY if you already add them in Chrome — otherwise leave Header's other props untouched until Task 7. (The new test passes `stats`/`runningIds`; declare them now as optional unused props `stats?: unknown; runningIds?: string[]` to keep this task minimal, Task 7 replaces them with the real types.)

- [ ] **Step 4: Retarget existing suites**

Run: `grep -rn '"1 repos"\|1 repos\|2 issues\|3 PRs\|p pull requests\|repoNwo\|refreshedAt' tests/ | grep -v node_modules | cut -d: -f1 | sort -u`
For each hit: title assertions drop the digit prefix; `repoNwo:` fixture keys become `crumbs: [...]`; `refreshedAt` fixture keys are deleted. Tests that PRESS "1"/"2"/"3" to switch panes: rewrite to arrow keys (`[C` right / `[D` left) or `tab`.

Run: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"`
Expected: exit 0.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit -p tsconfig.eslint.json 2>&1 | tail -5   # only NEW errors in touched files matter
npx prettier --write src/tui tests/tuiDeclutter.test.tsx
git add -A src tests
git commit -m "feat(tui): drop pane digits, daemon dot, header refresh stamp"
```

---

### Task 6: DaemonSection restyle + refreshed line

**Files:**

- Modify: `src/tui/components/sections.tsx:259-386` (DaemonSection), `src/tui/App.tsx:2916-2926` (props)
- Test: `tests/tuiDaemonPanel.test.tsx` (new; if a daemon-panel suite already exists — `grep -rln "DaemonSection" tests/` — extend it instead)

**Interfaces:**

- Consumes: `StatRow`, `Rule`, `Badge`, `Gauge`, `Scrollbar` (Tasks 1–3), `relTimeShort` (`./IssueList.js`).
- Produces: `DaemonSection` gains required props `refreshedAt: string | null` and `now: Date`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/tuiDaemonPanel.test.tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { DaemonSection } from "../src/tui/components/sections.js";
import type { DaemonDetail } from "../src/tui/localSnapshot.js";

const daemon: DaemonDetail = {
  up: true,
  pid: 42,
  uptimeSeconds: 7980,
  error: null,
  gate: { state: "ok", reason: null, until: null },
  endpointReachable: true,
  healthHost: "127.0.0.1",
  healthPort: 8787,
  guardNudges: 1,
  guardKills: 0,
  tokensIn: 10,
  tokensOut: 20,
  spend: { todayUsd: 1.5, dailyBudgetUsd: 5 },
  tasksByStatus: { done: 3 },
  progress: {},
} as DaemonDetail;

describe("DaemonSection", () => {
  it("renders stat rows, refreshed stamp, and spend gauge", () => {
    const { lastFrame } = render(
      <DaemonSection
        daemon={daemon}
        refreshedAt="2026-07-20T11:59:28Z"
        now={new Date("2026-07-20T12:00:00Z")}
        scroll={0}
        height={24}
        focused
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("state");
    expect(f).toContain("up 2h13m");
    expect(f).toContain("pid 42");
    expect(f).toContain("refreshed");
    expect(f).toContain("↻ 32s ago");
    expect(f).toContain("▰"); // spend gauge (1.5/5 budget)
    expect(f).toContain("── activity");
  });
  it("renders — for a never-refreshed stamp", () => {
    const { lastFrame } = render(
      <DaemonSection
        daemon={daemon}
        refreshedAt={null}
        now={new Date()}
        scroll={0}
        height={24}
        focused
      />,
    );
    expect(lastFrame()).toContain("refreshed  —");
  });
});
```

(If `DaemonDetail`'s exact fields differ, shape the fixture from the interface in `src/tui/localSnapshot.ts` — cast through `unknown` only as a last resort, per the repo's fixture-cast gotcha.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiDaemonPanel.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -8 /tmp/out`
Expected: exit 1 — unknown props `refreshedAt`/`now`.

- [ ] **Step 3: Restyle DaemonSection**

Replace the line-building body (`sections.tsx:295-381`) with a StatRow grid (`const LW = 11;` label width), keeping every existing datum:

```tsx
const lines: React.JSX.Element[] = [];
lines.push(
  <Text key="t" bold color={focused ? theme.accent : undefined}>
    daemon
  </Text>,
);
if (daemon.error !== null) {
  lines.push(
    <Text key="err" dimColor wrap="truncate-end">
      unavailable: {daemon.error}
    </Text>,
  );
}
const LW = 11;
lines.push(
  daemon.up ? (
    <StatRow
      key="state"
      label="state"
      value={`up ${fmtDur(daemon.uptimeSeconds)}`}
      labelWidth={LW}
      color={theme.success}
      hint={daemon.pid !== null ? `pid ${daemon.pid}` : undefined}
    />
  ) : (
    <StatRow key="state" label="state" value="down" labelWidth={LW} color={theme.warn} />
  ),
);
lines.push(
  <StatRow
    key="refreshed"
    label="refreshed"
    value={refreshedAt !== null ? `↻ ${relTimeShort(refreshedAt, now)} ago` : "—"}
    labelWidth={LW}
    hint="github data"
  />,
);
lines.push(<Rule key="r-ep" title="endpoint" width={24} />);
const gateState = daemon.gate?.state ?? "ok";
const epColor = GATE_RED.has(gateState)
  ? theme.error
  : GATE_YELLOW.has(gateState)
    ? theme.warn
    : daemon.endpointReachable
      ? theme.success
      : theme.warn;
lines.push(
  <Text key="ep">
    <Text dimColor>{"endpoint".padEnd(LW)}</Text>
    {gateState !== "ok" ? (
      <Badge label={gateState.replace(/_/g, " ")} color={epColor} />
    ) : (
      <Text bold color={epColor}>
        {daemon.endpointReachable ? "reachable" : "unreachable"}
      </Text>
    )}
  </Text>,
);
if (daemon.gate !== null && daemon.gate.state !== "ok" && daemon.gate.reason !== null) {
  lines.push(
    <Text key="gate-r" color={epColor} wrap="truncate-end">
      {" ".repeat(LW)}
      {daemon.gate.reason}
    </Text>,
  );
}
lines.push(
  <StatRow
    key="hp"
    label="health"
    value={`${daemon.healthHost}:${daemon.healthPort}`}
    labelWidth={LW}
  />,
);
lines.push(<Rule key="r-act" title="activity" width={24} />);
lines.push(
  <StatRow
    key="g"
    label="guard"
    value={`${daemon.guardNudges ?? 0} nudges · ${daemon.guardKills ?? 0} kills`}
    labelWidth={LW}
  />,
);
lines.push(
  <StatRow
    key="tok"
    label="tokens"
    value={`${daemon.tokensIn ?? 0} in · ${daemon.tokensOut ?? 0} out`}
    labelWidth={LW}
  />,
);
if (daemon.spend !== null) {
  lines.push(
    <StatRow
      key="spend"
      label="spend"
      value={`$${daemon.spend.todayUsd.toFixed(2)} today`}
      labelWidth={LW}
      hint={
        daemon.spend.dailyBudgetUsd > 0
          ? `of $${daemon.spend.dailyBudgetUsd.toFixed(2)} budget`
          : undefined
      }
    />,
  );
  if (daemon.spend.dailyBudgetUsd > 0) {
    lines.push(
      <Text key="spend-g">
        {" ".repeat(LW)}
        <Gauge
          value={daemon.spend.todayUsd}
          max={daemon.spend.dailyBudgetUsd}
          width={12}
          color={
            daemon.spend.todayUsd / daemon.spend.dailyBudgetUsd >= 0.8 ? theme.warn : theme.info
          }
        />
      </Text>,
    );
  }
}
const statuses = Object.entries(daemon.tasksByStatus);
if (statuses.length > 0) {
  lines.push(
    <StatRow
      key="tbs"
      label="tasks"
      value={statuses.map(([k, v]) => `${k}:${v}`).join(" · ")}
      labelWidth={LW}
    />,
  );
}
for (const [id, p] of Object.entries(daemon.progress)) {
  lines.push(
    <Text key={`pg-${id}`} wrap="truncate-end">
      {"  "}
      {queueLabel(null, id)} turn {p.turns}
      {p.lastTool !== null ? ` · ${p.lastTool}` : ""} · {p.outputTokens} tok
    </Text>,
  );
}
```

Add imports at the top of `sections.tsx`:

```tsx
import { StatRow } from "./primitives/StatRow.js";
import { Rule } from "./primitives/Rule.js";
import { Badge } from "./primitives/Badge.js";
import { Gauge } from "./primitives/Gauge.js";
import { Scrollbar } from "./primitives/Scrollbar.js";
import { relTimeShort } from "./IssueList.js";
```

Extend the props: `refreshedAt: string | null; now: Date;` (delete the old `pid/up`-line and endpoint-dot code paths this replaces — the `epDot` const dies here). Replace the final slice/return with a scrollbar wrapper:

```tsx
const visible = Math.max(1, height - 3);
onScrollMax?.(maxScroll(lines.length, visible));
const start = clampScroll(scroll, lines.length, visible);
return React.cloneElement(
  border,
  {},
  <Box flexGrow={1}>
    <Box flexDirection="column" flexGrow={1} minWidth={0}>
      {lines.slice(start, start + visible)}
    </Box>
    <Scrollbar offset={start} viewport={visible} total={lines.length} height={visible} />
  </Box>,
);
```

(`Box` is already imported in sections.tsx.) In `App.tsx:2916-2926` pass `refreshedAt={refreshedAt}` and `now={queueNow}` to `DaemonSection`.

- [ ] **Step 4: Run to verify pass + full suite**

Run: `npx vitest run tests/tuiDaemonPanel.test.tsx > /tmp/out 2>&1; echo "exit: $?"`
Expected: exit 0. Then the full suite (existing daemon-panel assertions on `pid 42 · up …` phrasing will need retargeting to the StatRow layout — `grep -rn "not running\|pid .* · up" tests/`).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui tests/tuiDaemonPanel.test.tsx
git add -A src tests
git commit -m "feat(tui): daemon panel stat grid, refreshed stamp, spend gauge"
```

---

### Task 7: Header overhaul — crumbs, live chips, groups

**Files:**

- Modify: `src/tui/components/Chrome.tsx` (Header), `src/tui/App.tsx` (crumbs memo + Header props)
- Test: `tests/tuiHeaderPulse.test.tsx` (new)

**Interfaces:**

- Consumes: `QueueStats` (`src/tui/queueStats.ts`), `fmtDurShort` (`src/tui/queueFmt.ts`).
- Produces: Header props (final): `crumbs: string[]`, `health: HealthInfo | null`, `reviewCount`, `now`, `mode`, `queueRunning`, `queueWaiting`, `watchlistError`, `outboxDepth`, `prAttention`, `prFailing`, `updateLatest?`, `stats: QueueStats | null`, `runningIds: string[]`.

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/tuiHeaderPulse.test.tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Header } from "../src/tui/components/Chrome.js";
import type { QueueStats } from "../src/tui/queueStats.js";

const base = {
  crumbs: ["acme/site"],
  health: {
    up: true,
    uptimeSeconds: 60,
    lastBridgeSweepAt: null,
    ticketsBridged: null,
    tasksProcessed: null,
    tasksSucceeded: null,
    tasksFailed: null,
    lastTaskStatus: null,
    lastTaskAt: null,
    totalTokensOut: 999,
    bridgeErrors: null,
  },
  reviewCount: 0,
  now: new Date("2026-07-20T12:00:00Z"),
  mode: "wide" as const,
  queueRunning: 0,
  queueWaiting: 0,
  watchlistError: null,
  outboxDepth: 0,
  prAttention: 0,
  prFailing: false,
  stats: null as QueueStats | null,
  runningIds: [] as string[],
};

const stats: QueueStats = {
  gate: { state: "ok", reason: null, until: null },
  lastPollAt: null,
  window24h: {
    done: 12,
    failed: 1,
    successRate: 0.92,
    avgDurationSeconds: null,
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
  },
  perDay7d: [],
  etaSeconds: 480,
  spend: null,
  guards: null,
  outbox: { depth: 0, dead: 0 },
  pendingRestartFields: [],
};

describe("header pulse", () => {
  it("shows the 24h record chip from stats", () => {
    const { lastFrame } = render(<Header {...base} stats={stats} />);
    expect(lastFrame()).toContain("24h ✓12 ✗1 92%");
  });
  it("hides the 24h chip with an empty ledger window", () => {
    const empty = { ...stats, window24h: { ...stats.window24h, done: 0, failed: 0 } };
    const { lastFrame } = render(<Header {...base} stats={empty} />);
    expect(lastFrame()).not.toContain("24h ");
  });
  it("shows the live run chip and eta when running/waiting", () => {
    const { lastFrame } = render(
      <Header
        {...base}
        stats={stats}
        runningIds={["fix-login", "other"]}
        queueRunning={2}
        queueWaiting={3}
      />,
    );
    expect(lastFrame()).toContain("▸ fix-login +1");
    expect(lastFrame()).toContain("eta 8m");
  });
  it("shows gate and restart-pending warnings", () => {
    const warn = {
      ...stats,
      gate: { state: "rate_limited", reason: "429 from provider", until: null },
      pendingRestartFields: ["maxConcurrent"],
    };
    const { lastFrame } = render(<Header {...base} stats={warn} mode="medium" />);
    expect(lastFrame()).toContain("gate ⚠ 429 from provider");
    expect(lastFrame()).toContain("restart pending");
  });
  it("since-restart ✓/✗ and tok chips are gone", () => {
    const { lastFrame } = render(<Header {...base} />);
    expect(lastFrame()).not.toContain("tok 999");
  });
  it("renders crumbs joined with the trail separator", () => {
    const { lastFrame } = render(<Header {...base} crumbs={["acme/site", "#124"]} />);
    expect(lastFrame()).toContain("acme/site ▸ #124");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiHeaderPulse.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -8 /tmp/out`
Expected: exit 1.

- [ ] **Step 3: Rewrite the Header pulse**

In `Chrome.tsx`: type the new props (`stats: QueueStats | null; runningIds: string[]` — import `type QueueStats` from `../queueStats.js`, `fmtDurShort` from `../queueFmt.js`), delete the since-restart `✓/✗` block, the `tok` chip, and (from Task 5) the ↻ chip. Build the pulse as four chip groups joined by dim `│`:

```tsx
const w = stats?.window24h ?? null;
const gate = stats?.gate ?? null;
const warnChips: React.JSX.Element[] = [];
if (wide && updateLatest != null)
  warnChips.push(
    <Text key="up" color={theme.accent}>
      ⬆ v{updateLatest}
    </Text>,
  );
if (watchlistError !== null)
  warnChips.push(
    <Text key="wl" color={theme.warn}>
      watchlist!
    </Text>,
  );
if (gate !== null && gate.state !== "ok")
  warnChips.push(
    <Text key="gate" color={theme.warn}>
      gate ⚠ {(gate.reason ?? gate.state.replace(/_/g, " ")).slice(0, 24)}
    </Text>,
  );
if ((stats?.pendingRestartFields.length ?? 0) > 0)
  warnChips.push(
    <Text key="rp" color={theme.warn}>
      restart pending
    </Text>,
  );
if (wide && bridgeErrors !== null && bridgeErrors > 0)
  warnChips.push(
    <Text key="br" color={theme.warn}>
      bridge ✗{bridgeErrors}
    </Text>,
  );
if (reviewCount > 0)
  warnChips.push(
    <Text key="rv" color={theme.warn}>
      ●{reviewCount} review
    </Text>,
  );
if (prAttention > 0)
  warnChips.push(
    <Text key="pr" color={prFailing ? theme.error : theme.warn}>
      ⚑{prAttention} PR
    </Text>,
  );

const recordChips: React.JSX.Element[] = [];
if (wide && w !== null && w.done + w.failed > 0)
  recordChips.push(
    <Text key="24h">
      24h <Text color={theme.success}>✓{w.done}</Text>{" "}
      <Text color={w.failed > 0 ? theme.error : undefined}>✗{w.failed}</Text>
      {w.successRate !== null ? ` ${Math.round(w.successRate * 100)}%` : ""}
    </Text>,
  );
if (wide && lastTaskAt !== null)
  recordChips.push(
    <Text key="last">
      last <Text color={lastGood ? theme.success : theme.error}>{lastGood ? "✓" : "✗"}</Text>{" "}
      {relTime(lastTaskAt, now)}
    </Text>,
  );

const liveChips: React.JSX.Element[] = [];
if (runningIds.length > 0)
  liveChips.push(
    <Text key="run" color={theme.info}>
      ▸ {runningIds[0].slice(0, 20)}
      {runningIds.length > 1 ? ` +${runningIds.length - 1}` : ""}
    </Text>,
  );
if (wide && queueWaiting > 0 && stats?.etaSeconds != null && stats.etaSeconds !== 0)
  liveChips.push(
    <Text key="eta" dimColor>
      eta {fmtDurShort(stats.etaSeconds)}
    </Text>,
  );

const systemChips: React.JSX.Element[] = [];
systemChips.push(
  <Text key="d" color={daemonUp ? theme.success : theme.warn}>
    {daemon}
  </Text>,
);
if (queueRunning + queueWaiting > 0)
  systemChips.push(
    <Text key="q" color={theme.info}>
      ◐{queueRunning} ⏳{queueWaiting}
    </Text>,
  );
if (outboxDepth > 0)
  systemChips.push(
    <Text key="ob" color={theme.warn}>
      ⇡{outboxDepth} unpushed
    </Text>,
  );

const groups = [warnChips, recordChips, liveChips, systemChips].filter((g) => g.length > 0);
```

Render (replacing the old chip `<Box flexShrink={0} gap={2}>…</Box>`):

```tsx
<Box flexShrink={0} gap={1}>
  {groups.map((g, gi) => (
    <React.Fragment key={gi}>
      {gi > 0 ? <Text dimColor>│</Text> : null}
      <Box gap={2}>{g}</Box>
    </React.Fragment>
  ))}
</Box>
```

Crumb cell (replacing the repo-name Text):

```tsx
<Box flexShrink={1} minWidth={0}>
  <Text bold wrap="truncate">
    {crumbs.map((c, i) => (
      <React.Fragment key={i}>
        {i > 0 ? <Text dimColor> ▸ </Text> : null}
        {c}
      </React.Fragment>
    ))}
  </Text>
</Box>
```

In `App.tsx`: add the crumbs memo near `pane3Title` (~line 606):

```tsx
const crumbs = useMemo((): string[] => {
  if (view === "prs") return ["pull requests"];
  if (view === "review") return ["review"];
  if (view === "cmdOutput" && cmd) return ["command", cmd.title];
  if (view === "detail" && detail)
    return [...(currentNwo !== null ? [currentNwo] : []), `#${detail.issue.number}`];
  if (view === "prDetail" && prDetail) return [prDetail.pr.nwo, `PR #${prDetail.pr.number}`];
  if (view === "repoDetail" && repoDetailTarget)
    return [repoDetailTarget.nwo ?? truncStart(repoDetailTarget.path, 30)];
  if (body?.kind === "section") return ["system", body.section];
  return [currentNwo ?? "no repo"];
}, [view, cmd, detail, prDetail, repoDetailTarget, body, currentNwo]);
```

(`truncStart` import from `./components/sections.js` if not already imported.) Header call site: `crumbs={crumbs}`, `stats={localCheap?.queue.stats ?? queueSnap?.stats ?? null}`, `runningIds={(localCheap?.queue ?? queueSnap)?.running.map((r) => r.id) ?? []}`.

- [ ] **Step 4: Run to verify pass + full suite**

Run: `npx vitest run tests/tuiHeaderPulse.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → exit 0, then the full suite; retarget any header assertions that pinned dropped chips (`grep -rn '"tok \|✓.*✗.*daemon' tests/tuiChrome.test.tsx tests/tuiUpdateChip.test.tsx`), and update `tests/tuiUpdateChip.test.tsx` fixtures for the new required props (`crumbs`, `stats`, `runningIds`).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui tests
git add -A src tests
git commit -m "feat(tui): header breadcrumbs + grouped live-metric pulse"
```

---

### Task 8: Columnar IssueList (header strip, pills, geometry)

**Files:**

- Modify: `src/tui/state.ts` (export MAX_STATE_BADGE_LEN), `src/tui/components/IssueList.tsx`, `src/tui/geometry.ts:26-29`
- Test: `tests/tuiIssueColumns.test.tsx` (new)

**Interfaces:**

- Consumes: `TableHeader`, `Column`, `Badge` (Tasks 1, 4).
- Produces: `MAX_STATE_BADGE_LEN: number` (state.ts); IssueList rows as fixed cells: gutter(1) · glyph(1) · num(5,right) · title(flex) · pill(MAX_STATE_BADGE_LEN+2) · age(4,right). `listRowsHeight(bodyRows) = bodyRows - 5`.

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/tuiIssueColumns.test.tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { IssueList } from "../src/tui/components/IssueList.js";
import { MAX_STATE_BADGE_LEN } from "../src/tui/state.js";
import { listRowsHeight } from "../src/tui/geometry.js";
import type { DashIssue } from "../src/tui/state.js";

const issues: DashIssue[] = [
  { number: 7, title: "short", labels: [], updatedAt: "2026-07-20T11:00:00Z", url: "u" },
  { number: 123, title: "longer title", labels: [], updatedAt: "2026-07-20T10:00:00Z", url: "u" },
] as DashIssue[];

const props = {
  issues,
  trigger: "junco",
  selected: 0,
  focused: true,
  refreshing: false,
  filter: "",
  filtering: false,
  height: 20,
  now: new Date("2026-07-20T12:00:00Z"),
  staleAt: null,
  window: { start: 0, end: 2 },
};

describe("columnar IssueList", () => {
  it("renders a header strip with column labels", () => {
    const { lastFrame } = render(<IssueList {...props} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("title");
    expect(f).toContain("state");
    expect(f).toContain("age");
  });
  it("badge column width derives from the meta table", () => {
    expect(MAX_STATE_BADGE_LEN).toBeGreaterThanOrEqual("plan-ready".length);
  });
  it("age cells render inside the fixed right column", () => {
    const { lastFrame } = render(<IssueList {...props} />);
    // pane is bordered — the age cell sits just inside the right border
    expect(lastFrame()).toMatch(/1h\s*│/);
  });
  it("listRowsHeight budgets the header strip", () => {
    expect(listRowsHeight(20)).toBe(15);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiIssueColumns.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1 (`MAX_STATE_BADGE_LEN` not exported; header labels absent; geometry 16≠15).

- [ ] **Step 3: Implement**

1. `state.ts` — directly under the `META` table (line ~56):

```ts
/** Longest lifecycle badge — the pill column's shared inner width. */
export const MAX_STATE_BADGE_LEN = Math.max(...Object.values(META).map((m) => m.badge.length));
```

2. `geometry.ts:26-29`:

```ts
/** Rows the issue/PR lists can show: borders(2) + title(1) + header strip(1)
 * + position line(1). */
export function listRowsHeight(bodyRows: number): number {
  return Math.max(1, bodyRows - 5);
}
```

3. `IssueList.tsx` — add imports:

```tsx
import { TableHeader, type Column } from "./primitives/TableHeader.js";
import { Badge } from "./primitives/Badge.js";
import { MAX_STATE_BADGE_LEN } from "../state.js";
```

Column spec at module scope:

```tsx
const AGE_W = 4; // relTime can emit "365d"
const PILL_W = MAX_STATE_BADGE_LEN + 2; // badgeText pad spaces
const COLUMNS: Column[] = [
  { label: "", width: 1 },
  { label: "", width: 1 },
  { label: "#", width: 5, align: "right" },
  { label: "title", width: "flex" },
  { label: "state", width: PILL_W },
  { label: "age", width: AGE_W, align: "right" },
];
```

Render `<TableHeader columns={COLUMNS} />` directly after the title Text. Rebuild each row with mirrored fixed cells (replacing the current loose row body at lines 108-125):

```tsx
<ClickableBox
  key={iss.number}
  width="100%"
  backgroundColor={sel ? theme.selectionBg : undefined}
  hoverBg={sel ? theme.selectionBg : theme.hoverBg}
  gap={1}
  onPress={onRowPress ? () => onRowPress(idx) : undefined}
>
  <Box flexShrink={0} width={1}>
    <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
  </Box>
  <Box flexShrink={0} width={1}>
    <Text color={meta.color}>{meta.glyph}</Text>
  </Box>
  <Box flexShrink={0} width={5}>
    <Text dimColor={!sel}>{`#${iss.number}`.padStart(5)}</Text>
  </Box>
  <Box flexGrow={1} minWidth={0}>
    <Text wrap="truncate">{iss.title}</Text>
  </Box>
  <Box flexShrink={0} width={PILL_W}>
    <Badge label={meta.badge} color={meta.color} padTo={MAX_STATE_BADGE_LEN} />
  </Box>
  <Box flexShrink={0} width={AGE_W} justifyContent="flex-end">
    <Text dimColor>{relTime(iss.updatedAt, now)}</Text>
  </Box>
</ClickableBox>
```

- [ ] **Step 4: Run to verify pass + full suite**

Run: `npx vitest run tests/tuiIssueColumns.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → exit 0. Full suite: window-count pins on `listRowsHeight` shrink by one — `grep -rn "listRowsHeight\|window: { start" tests/ | head` and retarget the arithmetic pins; PrList shows one fewer row until Task 9 (window smaller than space — safe).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui tests
git add -A src tests
git commit -m "feat(tui): columnar issue list with header strip and state pills"
```

---

### Task 9: Columnar PrList (both variants)

**Files:**

- Modify: `src/tui/prState.ts` (export MAX_PR_BADGE_LEN), `src/tui/components/PrList.tsx`
- Test: `tests/tuiPrColumns.test.tsx` (new)

**Interfaces:**

- Consumes: `TableHeader`, `Column`, `Badge`, `MAX_PR_BADGE_LEN`.
- Produces: PrList cells: gutter(1) · glyph(1) · num(5) · title(flex) · [repo(dataset-max ≤ NWO_MAX_WIDTH, min "repo".length)] · checks(dataset-max, min "checks".length) · pill(MAX_PR_BADGE_LEN+2) · age(4). `checksToString` becomes exported for the width calc test.

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/tuiPrColumns.test.tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { PrList } from "../src/tui/components/PrList.js";
import { MAX_PR_BADGE_LEN } from "../src/tui/prState.js";
import type { DashPr } from "../src/tui/prState.js";

const pr = (n: number, title: string): DashPr =>
  ({
    number: n,
    title,
    url: "u",
    headRefName: "junco/x",
    baseRefName: "main",
    isDraft: false,
    state: "OPEN",
    reviewDecision: null,
    mergeable: null,
    mergeStateStatus: null,
    checks: { pass: 2, fail: 0, pending: 0, total: 2 },
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    createdAt: "2026-07-20T10:00:00Z",
    updatedAt: "2026-07-20T11:00:00Z",
    mergedAt: null,
    author: "junco-bot",
    labels: [],
    nwo: "acme/site",
  }) as DashPr;

const props = {
  prs: [pr(1, "one"), pr(22, "two")],
  selected: 0,
  focused: true,
  height: 20,
  now: new Date("2026-07-20T12:00:00Z"),
  staleAt: null,
  window: { start: 0, end: 2 },
};

describe("columnar PrList", () => {
  it("renders header labels incl. repo and checks (showNwo)", () => {
    const { lastFrame } = render(<PrList {...props} />);
    const f = lastFrame() ?? "";
    for (const label of ["#", "title", "repo", "checks", "state", "age"]) {
      expect(f).toContain(label);
    }
  });
  it("omits the repo column when showNwo is false", () => {
    const { lastFrame } = render(<PrList {...props} showNwo={false} />);
    expect(lastFrame()).not.toContain("repo");
  });
  it("badge width covers the longest pr badge", () => {
    expect(MAX_PR_BADGE_LEN).toBeGreaterThanOrEqual("checks-failing".length);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiPrColumns.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1 (`MAX_PR_BADGE_LEN` missing; "checks" label absent).

- [ ] **Step 3: Implement**

1. `prState.ts` under its `META` table: `export const MAX_PR_BADGE_LEN = Math.max(...Object.values(META).map((m) => m.badge.length));`
2. `PrList.tsx`: export `checksToString`; add imports (TableHeader/Column/Badge/MAX_PR_BADGE_LEN). Inside the component compute dataset-stable widths:

```tsx
const AGE_W = 4;
const PILL_W = MAX_PR_BADGE_LEN + 2;
const repoW = showNwo
  ? Math.min(NWO_MAX_WIDTH, Math.max("repo".length, ...prs.map((p) => p.nwo.length), 0))
  : 0;
const checksW = Math.max("checks".length, ...prs.map((p) => checksToString(p.checks).length), 0);
const columns: Column[] = [
  { label: "", width: 1 },
  { label: "", width: 1 },
  { label: "#", width: 5, align: "right" },
  { label: "title", width: "flex" },
  ...(showNwo ? [{ label: "repo", width: repoW } as Column] : []),
  { label: "checks", width: checksW },
  { label: "state", width: PILL_W },
  { label: "age", width: AGE_W, align: "right" },
];
```

Render `<TableHeader columns={columns} />` after the title. Rebuild rows mirroring the columns (replacing lines 101-141): gutter/glyph/num/title cells exactly as IssueList (Task 8 code); then

```tsx
{showNwo && (
  <Box flexShrink={0} width={repoW}>
    <Text dimColor wrap="truncate-start">
      {prItem.nwo}
    </Text>
  </Box>
)}
<Box flexShrink={0} width={checksW}>
  <Text color={checksColor}>{checksStr}</Text>
</Box>
<Box flexShrink={0} width={PILL_W}>
  <Badge label={meta.badge} color={meta.color} padTo={MAX_PR_BADGE_LEN} />
</Box>
<Box flexShrink={0} width={AGE_W} justifyContent="flex-end">
  <Text dimColor>{relTime(prItem.updatedAt, now)}</Text>
</Box>
```

(The old per-row `width={Math.min(prItem.nwo.length, NWO_MAX_WIDTH)}` ragged cell dies here — that per-row raggedness is the §3 bug.)

- [ ] **Step 4: Run to verify pass + full suite**

Run: `npx vitest run tests/tuiPrColumns.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0; then full suite, retargeting PR-row assertions that matched the old loose layout.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui tests
git add -A src tests
git commit -m "feat(tui): columnar pr list with header strip and state pills"
```

---

### Task 10: Reserved third slot + ActivityCard

**Files:**

- Create: `src/tui/components/ActivityCard.tsx`
- Modify: `src/tui/App.tsx:2968-3004` (pane-3 arm)
- Test: `tests/tuiActivityCard.test.tsx` (new)

**Interfaces:**

- Consumes: `QueueStats`, `Sparkline`, `StatRow`, `Rule`, `fmtDurShort`, `fmtCompact`.
- Produces: `ActivityCard({stats, width, height})`; `ReservedNote({text, width, height})`.

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/tuiActivityCard.test.tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { ActivityCard, ReservedNote } from "../src/tui/components/ActivityCard.js";
import type { QueueStats } from "../src/tui/queueStats.js";

const stats: QueueStats = {
  gate: null,
  lastPollAt: null,
  window24h: {
    done: 12,
    failed: 1,
    successRate: 0.92,
    avgDurationSeconds: 360,
    tokensIn: 900_000,
    tokensOut: 1_200_000,
    costUsd: 3.2,
  },
  perDay7d: [
    { done: 2, failed: 0 },
    { done: 4, failed: 1 },
    { done: 8, failed: 0 },
    { done: 0, failed: 0 },
    { done: 3, failed: 0 },
    { done: 5, failed: 1 },
    { done: 2, failed: 0 },
  ],
  etaSeconds: null,
  spend: null,
  guards: null,
  outbox: { depth: 0, dead: 0 },
  pendingRestartFields: [],
};

describe("ActivityCard", () => {
  it("renders 7d bars, totals, 24h record, avg, cost", () => {
    const { lastFrame } = render(<ActivityCard stats={stats} width={40} height={16} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("activity");
    expect(f).toContain("✓24 ✗2"); // 7d totals
    expect(f).toContain("✓12 ✗1 · 92%");
    expect(f).toContain("avg 6m");
    expect(f).toContain("tok 1.2m");
    expect(f).toContain("$3.20");
  });
  it("null stats → no history note", () => {
    const { lastFrame } = render(<ActivityCard stats={null} width={40} height={16} />);
    expect(lastFrame()).toContain("no history yet");
  });
  it("ReservedNote renders the dim note", () => {
    const { lastFrame } = render(
      <ReservedNote text="local repo — no linked PRs" width={40} height={16} />,
    );
    expect(lastFrame()).toContain("local repo — no linked PRs");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiActivityCard.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1 — module not found. (Check `fmtCompact(1_200_000)` renders `1.2m` — `grep -n "fmtCompact" -A 8 src/tui/queueFmt.ts`; align the expectation with its actual output before running.)

- [ ] **Step 3: Implement**

```tsx
// src/tui/components/ActivityCard.tsx
/** Pane-3 card for system-row selections: the 7-day ledger at a glance.
 * Pure render over QueueStats — no fetches (spec §3). */
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { fmtCompact, fmtDurShort } from "../queueFmt.js";
import { Sparkline } from "./primitives/Sparkline.js";
import { StatRow } from "./primitives/StatRow.js";
import { Rule } from "./primitives/Rule.js";
import type { QueueStats } from "../queueStats.js";

const LW = 6;

export function ActivityCard({
  stats,
  width,
  height,
}: {
  stats: QueueStats | null;
  width: number;
  height: number;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
      height={height}
    >
      <Text bold>activity</Text>
      {stats === null ? (
        <Text dimColor>no history yet</Text>
      ) : (
        <>
          {stats.perDay7d.length > 0 && (
            <>
              <Text>
                <Text dimColor>{"7d".padEnd(LW)}</Text>
                <Sparkline
                  values={stats.perDay7d.map((p) => p.done + p.failed)}
                  color={theme.accent}
                />
              </Text>
              <Text>
                {" ".repeat(LW)}
                <Text color={theme.success}>
                  ✓{stats.perDay7d.reduce((a, p) => a + p.done, 0)}
                </Text>{" "}
                <Text color={theme.error}>✗{stats.perDay7d.reduce((a, p) => a + p.failed, 0)}</Text>
              </Text>
            </>
          )}
          <Rule title="24h" width={Math.max(8, width - 4)} />
          <Text>
            <Text dimColor>{"done".padEnd(LW)}</Text>
            <Text color={theme.success}>✓{stats.window24h.done}</Text>{" "}
            <Text color={stats.window24h.failed > 0 ? theme.error : undefined}>
              ✗{stats.window24h.failed}
            </Text>
            {stats.window24h.successRate !== null
              ? ` · ${Math.round(stats.window24h.successRate * 100)}%`
              : ""}
          </Text>
          {stats.window24h.avgDurationSeconds !== null && (
            <StatRow
              label="avg"
              value={fmtDurShort(stats.window24h.avgDurationSeconds)}
              labelWidth={LW}
              hint={
                stats.window24h.tokensOut !== null
                  ? `tok ${fmtCompact(stats.window24h.tokensOut)}`
                  : undefined
              }
            />
          )}
          {stats.window24h.costUsd !== null && (
            <StatRow
              label="cost"
              value={`$${stats.window24h.costUsd.toFixed(2)}`}
              labelWidth={LW}
            />
          )}
        </>
      )}
    </Box>
  );
}

/** Reserved-slot filler: keeps pane geometry frozen when the selection has no
 * third-column content (local repos). */
export function ReservedNote({
  text,
  width,
  height,
}: {
  text: string;
  width: number;
  height: number;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
      height={height}
    >
      <Text dimColor>{text}</Text>
    </Box>
  );
}
```

In `App.tsx` replace the pane-3 arm (lines 2968-3004 tail) — the `view === "main" && body?.kind === "issues"` PrList box stays exactly as-is; append two new arms so EVERY main-view body reserves the slot:

```tsx
) : view === "main" && body?.kind === "section" ? (
  <ActivityCard
    stats={localCheap?.queue.stats ?? queueSnap?.stats ?? null}
    width={layout.previewWidth}
    height={listHeight}
  />
) : view === "main" && body?.kind === "repoDetail" ? (
  <ReservedNote
    text="local repo — no linked PRs"
    width={layout.previewWidth}
    height={listHeight}
  />
) : null)}
```

(Import `ActivityCard`/`ReservedNote` in App.)

- [ ] **Step 4: Run + integration check**

Run: `npx vitest run tests/tuiActivityCard.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0. Add one integration assertion to the new file (render `<App>` via the existing local fixtures — see `tests/helpers/localFixtures.tsx` — select a system row at ≥120 cols and assert the frame contains `activity`); if App fixtures prove heavy, assert instead in the existing unified-view suite where a system row is already selected. Full suite green.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui tests
git add -A src tests
git commit -m "feat(tui): reserved third slot with activity card"
```

---

### Task 11: QueueView strips + running-row time gauge

**Files:**

- Modify: `src/tui/queueSnapshot.ts` (add `taskTimeoutSeconds`), `src/tui/components/QueueView.tsx`
- Test: `tests/tuiQueuePolish.test.tsx` (new)

**Interfaces:**

- Consumes: `Gauge` (Task 2), `theme.hoverBg`.
- Produces: `QueueSnapshot.taskTimeoutSeconds: number | null` (= `cfg.defaultTimeoutMinutes * 60`).

- [ ] **Step 1: Write the failing test**

```tsx
// tests/tuiQueuePolish.test.tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { QueueView } from "../src/tui/components/QueueView.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";

const snap: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  taskTimeoutSeconds: 2700,
  running: [
    {
      id: "fix-login",
      github: null,
      turns: 4,
      lastTool: "bash",
      outputTokens: 1200,
      startedAt: "2026-07-20T11:37:00Z",
      updatedAt: "2026-07-20T11:59:30Z",
      stale: false,
      repoPath: null,
    },
  ],
  waiting: [],
  recent: [],
  stats: null,
  outboxDepth: 0,
} as unknown as QueueSnapshot;

describe("queue polish", () => {
  it("running row shows the time-budget gauge", () => {
    const { lastFrame } = render(
      <QueueView
        snap={snap}
        scroll={0}
        now={new Date("2026-07-20T12:00:00Z")}
        height={20}
        focused
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("▰"); // 23m of 45m elapsed
    expect(f).toContain("23m / 45m budget");
  });
  it("no gauge when timeout unknown", () => {
    const noTo = { ...snap, taskTimeoutSeconds: null } as QueueSnapshot;
    const { lastFrame } = render(
      <QueueView
        snap={noTo}
        scroll={0}
        now={new Date("2026-07-20T12:00:00Z")}
        height={20}
        focused
      />,
    );
    expect(lastFrame()).not.toContain("budget");
  });
});
```

(Fixture note: `QueueSnapshot` literals also live in existing suites — after making `taskTimeoutSeconds` a required field, sweep `grep -rln "maxConcurrent" tests/` and add `taskTimeoutSeconds: null` to each literal; `npx tsc --noEmit -p tsconfig.eslint.json` finds the misses.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiQueuePolish.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1 (no gauge glyphs).

- [ ] **Step 3: Implement**

1. `queueSnapshot.ts`: add `taskTimeoutSeconds: number | null;` to the `QueueSnapshot` interface (doc: "Config default task budget — drives the running-row gauge; null when unknown"). Set it in BOTH snapshot literals (the error-path one near line 168-175 and the main build): `taskTimeoutSeconds: cfg.defaultTimeoutMinutes > 0 ? cfg.defaultTimeoutMinutes * 60 : null`.
2. `QueueView.tsx`: import `Gauge` + `Box`; add the strip helper and swap the four bold group headers:

```tsx
const strip = (key: string, label: string, extra?: React.JSX.Element | null): React.JSX.Element => (
  <Box key={key} width="100%" backgroundColor={theme.hoverBg}>
    <Text bold color={theme.accent}>
      {label}
    </Text>
    {extra ?? null}
  </Box>
);
```

- `rows.push(<Text key="run-h" …RUNNING…)` → `rows.push(strip("run-h", "running", <Text dimColor>{` (${snap.running.length}/${snap.maxConcurrent})${pollAge !== null ? ` · ↻ poll ${pollAge}` : ""}`}</Text>))`
- `WAITING` header → `strip("wait-h2", "waiting", <Text dimColor>{` (${waitSegs.join(" · ")})`}</Text>)`
- `RECENT` → `strip("rec-h2", "recent", null)`
- `STATS` → `strip("stats-t", "stats", null)`

3. After each running row's progress line (below the `rp-${r.id}` push):

```tsx
if (!r.stale && r.startedAt !== null && snap.taskTimeoutSeconds !== null) {
  const elapsedS = Math.max(0, Math.floor((now.getTime() - Date.parse(r.startedAt)) / 1000));
  rows.push(
    <Text key={`rg-${r.id}`} wrap="truncate-end">
      {"     "}
      <Gauge
        value={elapsedS}
        max={snap.taskTimeoutSeconds}
        width={12}
        color={elapsedS / snap.taskTimeoutSeconds >= 0.8 ? theme.warn : theme.info}
        label={`${fmtDurShort(elapsedS)} / ${fmtDurShort(snap.taskTimeoutSeconds)} budget`}
      />
    </Text>,
  );
}
```

- [ ] **Step 4: Run + sweep fixtures**

New test green; then `npx tsc --noEmit -p tsconfig.eslint.json` for missed `QueueSnapshot` literals (add `taskTimeoutSeconds: null`); full suite — queue-view text pins on `RUNNING (`/`WAITING (`/`RECENT`/`STATS` retarget to the lowercase strip labels.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui tests
git add -A src tests
git commit -m "feat(tui): queue header strips and running-ticket time gauge"
```

---

### Task 12: Bot-authored highlighting

**Files:**

- Create: `src/botIdentity.ts`
- Modify: `src/tui/state.ts` (DashIssue.author), `src/tui/ghClient.ts:296-326` (fetch+map), `src/tui/App.tsx` (botLogin state + list props), `src/dashboardCmd.ts` (pass `botLoginFn`), `src/tui/components/IssueList.tsx` + `PrList.tsx` (number-cell accent), `src/tui/components/HelpModal.tsx` (legend)
- Test: `tests/botIdentity.test.ts` (new) + `tests/tuiIssueColumns.test.tsx` (append)

**Interfaces:**

- Produces: `resolveBotLogin(cfg: Pick<Config, "botAccount">, deps?: BotIdentityDeps): Promise<string | null>`; `DashIssue.author: string | null`; App prop `botLoginFn?: () => Promise<string | null>`; IssueList/PrList prop `botLogin?: string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/botIdentity.test.ts
import { describe, it, expect } from "vitest";
import { resolveBotLogin } from "../src/botIdentity.js";

const cfg = (enabled: boolean) => ({ botAccount: { enabled, configDir: "/tmp/ghcfg" } });

describe("resolveBotLogin", () => {
  it("null when the bot account is disabled (no exec)", async () => {
    let called = false;
    const login = await resolveBotLogin(cfg(false), {
      execFn: async () => ((called = true), { code: 0, stdout: "x" }),
    });
    expect(login).toBeNull();
    expect(called).toBe(false);
  });
  it("resolves the login under the isolated config dir with tokens cleared", async () => {
    let seenEnv: NodeJS.ProcessEnv = {};
    const login = await resolveBotLogin(cfg(true), {
      execFn: async (_cmd, _args, env) => ((seenEnv = env), { code: 0, stdout: "junco-bot\n" }),
    });
    expect(login).toBe("junco-bot");
    expect(seenEnv.GH_CONFIG_DIR).toBe("/tmp/ghcfg");
    expect(seenEnv.GH_TOKEN).toBe("");
    expect(seenEnv.GITHUB_TOKEN).toBe("");
  });
  it("null on probe failure or empty output", async () => {
    expect(
      await resolveBotLogin(cfg(true), { execFn: async () => ({ code: 1, stdout: "" }) }),
    ).toBeNull();
    expect(
      await resolveBotLogin(cfg(true), { execFn: async () => ({ code: 0, stdout: "  " }) }),
    ).toBeNull();
  });
});
```

Append to `tests/tuiIssueColumns.test.tsx`:

```tsx
it("bot-authored rows render the number in accent (structural: not dim)", () => {
  const withAuthors = issues.map((i, idx) => ({
    ...i,
    author: idx === 0 ? "junco-bot" : "human",
  }));
  const { lastFrame } = render(
    <IssueList {...props} issues={withAuthors} botLogin="junco-bot" selected={1} />,
  );
  // frames strip ANSI — assert via the component's exported predicate instead
});
```

Replace that placeholder body with a pure-predicate test: export `isBotAuthored(author: string | null | undefined, botLogin: string | null | undefined): boolean` from `src/tui/state.ts` and assert its truth table (`("junco-bot","junco-bot")→true`, null/undefined/mismatch→false); the component test then only checks rendering doesn't crash with `botLogin` set.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/botIdentity.test.ts > /tmp/out 2>&1; echo "exit: $?"` → exit 1 (module not found).

- [ ] **Step 3: Implement**

```ts
// src/botIdentity.ts
/**
 * Bot-account identity probe for the dashboard: which login opens junco's
 * issues/PRs when `botAccount.enabled`? Mirrors the doctor's probe (gh api
 * user under the isolated GH_CONFIG_DIR, ambient tokens cleared — GH_TOKEN
 * outranks config dirs, the #186 gotcha). Null = disabled or unresolvable;
 * callers treat null as "feature inert".
 */
import { execFile } from "node:child_process";
import type { Config } from "./types.js";

export interface BotIdentityDeps {
  execFn?: (
    cmd: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<{ code: number; stdout: string }>;
}

function defaultExec(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { env, timeout: 10_000 }, (err, stdout) => {
      res({ code: err ? 1 : 0, stdout: String(stdout) });
    });
  });
}

export async function resolveBotLogin(
  cfg: Pick<Config, "botAccount">,
  deps: BotIdentityDeps = {},
): Promise<string | null> {
  if (!cfg.botAccount.enabled) return null;
  const execFn = deps.execFn ?? defaultExec;
  const r = await execFn("gh", ["api", "user", "--jq", ".login"], {
    ...process.env,
    GH_CONFIG_DIR: cfg.botAccount.configDir,
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
  });
  if (r.code !== 0) return null;
  const login = r.stdout.trim();
  return login === "" ? null : login;
}
```

2. `state.ts`: add `author: string | null;` to `DashIssue` (doc: "issue opener's login; null on pre-field cache entries") and

```ts
/** True when a list row was opened by the configured bot account. */
export function isBotAuthored(
  author: string | null | undefined,
  botLogin: string | null | undefined,
): boolean {
  return typeof author === "string" && author !== "" && author === botLogin;
}
```

3. `ghClient.ts` listIssues: `--json` string → `"number,title,labels,updatedAt,url,author"`; raw type gains `author?: { login?: string } | null`; map adds `author: i.author?.login ?? null`. (`DashPr` already has `author` — no PR fetch change.)
4. App: prop `botLoginFn?: () => Promise<string | null>`; state + effect:

```tsx
const [botLogin, setBotLogin] = useState<string | null>(null);
useEffect(() => {
  if (!props.botLoginFn) return;
  let on = true;
  void props.botLoginFn().then((l) => {
    if (on) setBotLogin(l);
  });
  return () => {
    on = false;
  };
}, [props.botLoginFn]);
```

Pass `botLogin={botLogin}` to `IssueList` and all three `PrList` usages. In `src/dashboardCmd.ts`, where `<App …>` props are assembled, add `botLoginFn={() => resolveBotLogin(cfg)}` (import from `./botIdentity.js`; `cfg` is in scope there). 5. IssueList/PrList: accept `botLogin?: string | null`; the number cell becomes

```tsx
<Text
  color={isBotAuthored(iss.author, botLogin) ? theme.accent : undefined}
  dimColor={!sel && !isBotAuthored(iss.author, botLogin)}
>
  {`#${iss.number}`.padStart(5)}
</Text>
```

(PrList: `prItem.author`.) Import `isBotAuthored` from `../state.js` in both. 6. HelpModal "system rows" section: append `["accent #", "issue/PR opened by the junco bot account"]`.

- [ ] **Step 4: Run + sweep**

`npx vitest run tests/botIdentity.test.ts tests/tuiIssueColumns.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0. `DashIssue` literals in tests now need `author` — `npx tsc --noEmit -p tsconfig.eslint.json`, add `author: null` where flagged. Full suite green.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src tests
git add -A src tests
git commit -m "feat(tui): highlight bot-authored issues and PRs"
```

---

### Task 13: Confirm-modal buttons

**Files:**

- Modify: `src/tui/App.tsx:2676-2682`
- Test: `tests/tuiConfirmButtons.test.tsx` (new; or append to the existing confirm-modal suite — `grep -rln "confirm" tests/tuiModal* tests/tuiApp*` first)

- [ ] **Step 1: Write the failing test**

Use the repo's App-render fixtures (`tests/helpers/localFixtures.tsx`) to open any guarded action's confirm (e.g. navigate to the queue system row and press `D` on a waiting ticket — mirror an existing confirm test's setup lines exactly). Then:

```tsx
await until(() => (lastFrame() ?? "").includes("confirm"));
expect(lastFrame()).toContain("[ esc cancel ]");
expect(lastFrame()).toContain(" y confirm ");
expect(lastFrame()).not.toContain("y/enter confirm · n/esc cancel");
```

- [ ] **Step 2: Run to verify failure** — the old hint line renders instead of buttons.

- [ ] **Step 3: Implement**

Replace the hint line (App.tsx:2680) with:

```tsx
<Box gap={2}>
  <Button
    keyHint="y"
    label="confirm"
    tone={confirm.danger ? "danger" : "primary"}
    onPress={() => {
      const fn = confirm.onConfirm;
      setConfirm(null);
      fn();
    }}
  />
  <Button keyHint="esc" label="cancel" tone="neutral" onPress={() => setConfirm(null)} />
</Box>
```

(Import `Button` from `./components/primitives/Button.js`. Keyboard layer 3 at App.tsx:2263-2275 is untouched — parity.)

- [ ] **Step 4: Run + full suite** (retarget any pins on the old hint text: `grep -rn "y/enter confirm" tests/`).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui tests
git add -A src tests
git commit -m "feat(tui): clickable confirm-dialog buttons"
```

---

### Task 14: RepoDetail + rail restyle

**Files:**

- Modify: `src/tui/components/RepoDetail.tsx`, `src/tui/components/UnifiedRail.tsx:140-141`
- Test: append to `tests/tuiRepoDetail.test.tsx`

- [ ] **Step 1: Write the failing assertions** (append)

```tsx
it("renders titled rules and stat rows", async () => {
  // reuse the existing render fixture in this file
  await until(() => (lastFrame() ?? "").includes("── worktrees"));
  expect(lastFrame()).toContain("── recent tickets");
  expect(lastFrame()).toMatch(/path\s{3,}/); // StatRow padding
});
```

And in `tests/tuiUnifiedRail.test.tsx`: the separator line assertion becomes `── system` (Rule) instead of the bare `─…` + `system` bold line pair.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

1. `RepoDetail.tsx`: import `StatRow`, `Rule`, `Scrollbar` from `./primitives/…`; `const LW = 8;`
   - `path` line → `<StatRow key="p" label="path" value={repo.path} labelWidth={LW} />` (value truncates via StatRow's `wrap="truncate-end"`).
   - branch line → `<StatRow key="g" label="branch" value={`${g.branch ?? "?"}${g.headSha !== null ? `@${g.headSha.slice(0, 7)}` : ""}`} labelWidth={LW} hint={g.dirty === true ? "✎ dirty" : undefined} color={g.dirty === true ? theme.warn : undefined} />`
   - origin line → `<StatRow key="o" label="origin" value={g.originUrl} labelWidth={LW} />`
   - clone lines → `<StatRow key={`c-${c}`} label="clone" value={truncStart(c, 40)} labelWidth={LW} />`
   - `" worktrees"` bold header → `<Rule key="wh" title="worktrees" width={24} />`; `" recent tickets"` → `<Rule key="qh" title="recent tickets" width={24} />`.
   - Wrap the slice in the DaemonSection scrollbar pattern (Task 6 Step 3 tail, with `visible = Math.max(1, height - 2)`).
2. `UnifiedRail.tsx:140-141`: replace the two lines (`─…` Text + `system` bold Text) with `<Rule title="system" width={Math.max(1, width - 4)} />` (import Rule). `SYSTEM_BLOCK_ROWS` in `geometry.ts` shrinks 7 → 6 (separator+title merged into one row) — update the constant, its doc comment, and any pinned tests (`grep -rn "SYSTEM_BLOCK_ROWS" src tests`).

- [ ] **Step 4: Run + full suite** (rail height pins shift by one row — retarget).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui tests
git add -A src tests
git commit -m "feat(tui): repo detail stat rows + titled rules in rail and panels"
```

---

### Task 15: Scrollbar sweep — Preview, CommandOutput, LogView

**Files:**

- Modify: `src/tui/components/Preview.tsx:88-98`, `src/tui/components/CommandOutput.tsx:50-59`, `src/tui/components/LogView.tsx:163-190` (full variant)
- Test: append to `tests/tuiPrimitives.test.tsx` (rendered-pane checks live in each surface's existing suite; add one Preview assertion)

- [ ] **Step 1: Failing assertion** (in the existing Preview suite, or new block in `tests/tuiPrimitives.test.tsx` rendering `Preview` with a 50-line body and `height={12}`): frame contains `█` and `│`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the shared pattern**

Preview.tsx — replace the visible-lines block + spacer (lines 88-93):

```tsx
<Box flexGrow={1}>
  <Box flexDirection="column" flexGrow={1} minWidth={0}>
    {visible.map((l, i) => (
      <Text key={i} wrap="truncate-end">
        {l || " "}
      </Text>
    ))}
  </Box>
  <Scrollbar offset={start} viewport={viewHeight} total={lines.length} height={viewHeight} />
</Box>
```

CommandOutput.tsx — same wrapper around its `visible.map` (offset `start`, viewport `visibleLines`, total `lines.length`, height `visibleLines`). LogView full variant — wrap the `rows.slice(start, start + visible).map(…)` region identically (offset `start`, viewport `visible`, total `rows.length`, height `visible`); the section variant (`height-3` tail, LogView.tsx:114-115) is click-to-expand and gets no bar. PrPreview has no scroll offset (fixed card) — deliberately skipped; note it in the commit body.

- [ ] **Step 4: Run + full suite.**

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui tests
git add -A src tests
git commit -m "feat(tui): scrollbars on scrollable panes"
```

---

### Task 16: Docs, CHANGELOG, full gate

**Files:**

- Modify: `docs/dashboard.md`, `CHANGELOG.md`, `ARCHITECTURE.md` (tui row)

- [ ] **Step 1: Update `docs/dashboard.md`**: pane titles without digits and the removed 1/2/3 keys; the top-bar chip table (§2 of the spec verbatim: groups, visibility rules); third-column behavior (PR monitor / activity card / local note); table headers + pills; primitives glossary (one line each); bot-authored accent `#`; daemon panel refreshed line; scrollbars.
- [ ] **Step 2: `CHANGELOG.md`** under `## [Unreleased]` → `### Changed`: `- Dashboard polish: digit-free panes (1/2/3 keys removed), grouped live-metric top bar (24h record, running ticket, ETA, gate/restart warnings; breadcrumb trail), columnar issue/PR tables with header strips and state pills, always-reserved third column (activity card), daemon panel stat grid with refresh stamp and spend gauge, scrollbars, clickable confirm buttons, bot-authored rows highlighted.`
- [ ] **Step 3: `ARCHITECTURE.md`**: extend the tui row's component enumeration with `components/primitives/` (one clause).
- [ ] **Step 4: Full gate**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`
Expected: all green (typecheck via tsconfig.eslint covers the test fixtures swept in Tasks 11–12).

- [ ] **Step 5: Commit**

```bash
git add docs/dashboard.md CHANGELOG.md ARCHITECTURE.md
git commit -m "docs(dashboard): polish — metrics bar, tables, primitives, bot highlight"
```
