// tests/useAssessHistory.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useAssessHistory } from "../src/tui/hooks/useAssessHistory.js";
import type { AssessHistory } from "../src/assessHistory.js";
import { until } from "./helpers/until.js";

const MARKER_ROW: AssessHistory = {
  id: "acme/widgets",
  lastSuccessAt: "2026-07-20T00:00:00.000Z",
  lastFound: 3,
  lastParked: 2,
  lastFailureAt: null,
  lastFailureReason: null,
};

function Probe({ fn }: { fn: () => Promise<AssessHistory[]> }) {
  const assessHistory = useAssessHistory(fn, 999999);
  const row = assessHistory.get("acme/widgets");
  return <Text>{row ? `found:${row.lastFound}:size:${assessHistory.size}` : "none"}</Text>;
}

describe("useAssessHistory", () => {
  it("fetches the assess history array once on mount and builds a Map keyed by id", async () => {
    const fakeFn = async () => [MARKER_ROW];
    const r = render(<Probe fn={fakeFn} />);
    expect(r.lastFrame()).toBe("none");
    await until(() => r.lastFrame() === "found:3:size:1");
    r.unmount();
  });
});
