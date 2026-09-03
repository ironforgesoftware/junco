import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { Badge, badgeText } from "../src/tui/components/primitives/Badge.js";
import { Rule, ruleText } from "../src/tui/components/primitives/Rule.js";
import { StatRow, statRowText } from "../src/tui/components/primitives/StatRow.js";
import { Gauge, gaugeText } from "../src/tui/components/primitives/Gauge.js";
import { Sparkline } from "../src/tui/components/primitives/Sparkline.js";
import { SectionStrip } from "../src/tui/components/primitives/SectionStrip.js";

describe("badgeText", () => {
  it("wraps the label in one pad space each side", () => {
    expect(badgeText("done")).toBe(" done ");
  });
  it("pads the label to padTo so pill columns align", () => {
    expect(badgeText("done", 10)).toBe(" done       ");
    expect(badgeText("plan-ready", 10)).toBe(" plan-ready ");
  });
  it("renders the padded label (frame strips ANSI)", () => {
    const { lastFrame } = render(
      <Box>
        <Badge label="failed" color="red" padTo={8} />
        <Text>|</Text>
      </Box>,
    );
    expect(lastFrame()).toContain(" failed   |");
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

describe("statRowText", () => {
  it("statRowText concatenates padded label, value, hint", () => {
    expect(statRowText("state", "up 2h", 10)).toBe("state     up 2h");
    expect(statRowText("state", "up 2h", 8, "pid 42")).toBe("state   up 2h pid 42");
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

describe("StatRow truncation", () => {
  it("defaults to truncating the value's end", () => {
    const { lastFrame } = render(
      <Box width={20}>
        <StatRow label="path" value="/home/alx/repos/acme-api" labelWidth={8} />
      </Box>,
    );
    expect(lastFrame()).toContain("/home/a"); // prefix survives
    expect(lastFrame()).not.toContain("acme-api");
  });

  it('truncate="start" keeps the discriminating tail', () => {
    const { lastFrame } = render(
      <Box width={20}>
        <StatRow label="path" value="/home/alx/repos/acme-api" labelWidth={8} truncate="start" />
      </Box>,
    );
    expect(lastFrame()).toContain("acme-api");
  });

  it("in the label-eating garble zone, the label cell stays whole and the value keeps its tail", () => {
    // At width=30 the old single-<Text> implementation truncates the whole
    // flattened "label+value" string from the front, landing mid-label: it
    // renders "…h    /home/alx/repos/acme-api" (only the last letter of
    // "path" survives). The fixed layout pins the label cell so it never
    // shrinks, truncating only the value.
    const { lastFrame } = render(
      <Box width={30}>
        <StatRow label="path" value="/home/alx/repos/acme-api" labelWidth={8} truncate="start" />
      </Box>,
    );
    const f = lastFrame() ?? "";
    expect(f).toMatch(/path {4}/); // full padded label, never partially eaten
    expect(f).toContain("acme-api"); // value's discriminating tail survives
  });
});

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
  it("negative width renders empty", () => {
    expect(gaugeText(5, 10, -3)).toBe("");
    expect(gaugeText(null, 10, -3)).toBe("");
  });
  it("negative max renders all track", () => {
    expect(gaugeText(3, -5, 6)).toBe("▱▱▱▱▱▱");
  });
  it("Gauge appends the label after the bar", () => {
    const { lastFrame } = render(<Gauge value={5} max={10} width={4} label="23m / 45m" />);
    expect(lastFrame()).toBe("▰▰▱▱ 23m / 45m");
  });
});

describe("Sparkline", () => {
  it("renders fmtSpark bars", () => {
    const { lastFrame } = render(<Sparkline values={[0, 1, 2, 4]} />);
    expect(lastFrame()).toBe("▁▃▅█");
  });
});

import {
  Scrollbar,
  scrollbarCells,
  scrollbarOffsetAt,
} from "../src/tui/components/primitives/Scrollbar.js";
import { Button } from "../src/tui/components/primitives/Button.js";
import { TableHeader, headerCell } from "../src/tui/components/primitives/TableHeader.js";
import { Preview } from "../src/tui/components/Preview.js";
import type { DashIssue } from "../src/tui/state.js";
import { makeDashIssue } from "./helpers/dashFixtures.js";

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

describe("scrollbarOffsetAt (click/drag to scroll)", () => {
  // 100 rows in a 10-row viewport ⇒ maxOffset 90, over a 10-cell track whose
  // last addressable row is 9: the ends must land exactly on 0 and 90, or a
  // drag to the bottom would stop short of the tail.
  it("maps the track's top and bottom rows to the offset extremes", () => {
    expect(scrollbarOffsetAt(0, 10, 10, 100)).toBe(0);
    expect(scrollbarOffsetAt(9, 10, 10, 100)).toBe(90);
    expect(scrollbarOffsetAt(5, 10, 10, 100)).toBe(50);
  });
  it("is 0 for any row when everything fits (nothing to scroll)", () => {
    expect(scrollbarOffsetAt(3, 10, 10, 8)).toBe(0);
    expect(scrollbarOffsetAt(0, 10, 10, 10)).toBe(0);
  });
  it("a one-row track never divides by zero", () => {
    expect(scrollbarOffsetAt(0, 1, 1, 5)).toBe(0);
  });
  it("Scrollbar with onScrollTo still renders nothing when the content fits", () => {
    const { lastFrame } = render(
      <Scrollbar offset={0} viewport={10} total={5} height={10} onScrollTo={() => {}} />,
    );
    expect(lastFrame()).toBe("");
  });
});

describe("Preview pane scrollbar (Task 15)", () => {
  const ISSUE: DashIssue = makeDashIssue({ number: 9, title: "Some issue", labels: [] });
  const base = {
    issue: ISSUE,
    trigger: "junco",
    planComment: null as string | null,
    loading: false,
    error: null as string | null,
    scroll: 0,
    focused: false,
  };

  it("renders a scrollbar thumb + track when the body overflows the viewport", () => {
    const body = Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join("\n");
    const f = render(<Preview {...base} body={body} height={12} />).lastFrame()!;
    expect(f).toContain("█");
    expect(f).toContain("│");
  });

  it("renders no scrollbar glyphs when the body fits in the viewport", () => {
    const body = Array.from({ length: 3 }, (_, i) => `L${i + 1}`).join("\n");
    const f = render(<Preview {...base} body={body} height={12} />).lastFrame()!;
    // The pane's own round border reuses "│" for its left/right edges, so
    // strip the border column off each row before asserting — this proves no
    // *extra* scrollbar track/thumb column appears in the interior, without
    // being trivially true/false from the border glyph itself.
    const interior = f
      .split("\n")
      .map((line) => line.slice(1, -1))
      .join("\n");
    expect(interior).not.toContain("█");
    expect(interior).not.toContain("│");
  });
});

describe("Button", () => {
  it("neutral tone renders bracketed key + label", () => {
    const { lastFrame } = render(<Button keyHint="esc" label="cancel" tone="neutral" />);
    expect(lastFrame()).toBe("[ esc cancel ]");
  });
  it("primary tone renders padded key + label (pill)", () => {
    const { lastFrame } = render(
      <Box>
        <Button keyHint="y" label="confirm" tone="primary" />
        <Text>|</Text>
      </Box>,
    );
    expect(lastFrame()).toBe(" y confirm |");
  });
});

describe("SectionStrip", () => {
  it("renders the label and an optional dim extra on one row", () => {
    const { lastFrame } = render(
      <SectionStrip label="running" extra={<Text dimColor> (1/2)</Text>} />,
    );
    expect(lastFrame()).toBe("running (1/2)");
    expect((lastFrame() ?? "").split("\n")).toHaveLength(1);
  });

  it("renders the bare label with no extra", () => {
    const { lastFrame } = render(<SectionStrip label="recent" />);
    expect(lastFrame()).toBe("recent");
  });
});

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
