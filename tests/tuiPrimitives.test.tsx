import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { Badge, badgeText } from "../src/tui/components/primitives/Badge.js";
import { Rule, ruleText } from "../src/tui/components/primitives/Rule.js";
import { StatRow, statRowText } from "../src/tui/components/primitives/StatRow.js";
import { Gauge, gaugeText } from "../src/tui/components/primitives/Gauge.js";
import { Sparkline } from "../src/tui/components/primitives/Sparkline.js";

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
    const { lastFrame } = render(
      <Box>
        <Button keyHint="y" label="confirm" tone="primary" />
        <Text>|</Text>
      </Box>,
    );
    expect(lastFrame()).toBe(" y confirm |");
  });
});
