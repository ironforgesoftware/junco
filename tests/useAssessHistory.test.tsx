// tests/useAssessHistory.test.tsx
import { describe, it, expect } from "vitest";
import React, { useRef } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useAssessHistory } from "../src/tui/hooks/useAssessHistory.js";
import type { AssessHistory } from "../src/assessHistory.js";
import { until } from "./helpers/until.js";

const ROW = (id: string): AssessHistory => ({
  id,
  lastSuccessAt: "2026-07-01T00:00:00Z",
  lastFound: 3,
  lastParked: 1,
  lastFailureAt: null,
  lastFailureReason: null,
});

describe("useAssessHistory", () => {
  it("rebuilds the Map only when the fetched rows change", async () => {
    let rows: AssessHistory[] = [ROW("acme/api")];
    let calls = 0;
    const fn = async (): Promise<AssessHistory[]> => {
      calls++;
      return rows.map((r) => ({ ...r })); // fresh objects, equal content
    };
    function RefProbe(): React.JSX.Element {
      const map = useAssessHistory(fn, 15);
      const seen = useRef(new Set<Map<string, AssessHistory>>());
      seen.current.add(map);
      return <Text>{`refs:${seen.current.size}:size:${map.size}`}</Text>;
    }
    const r = render(<RefProbe />);
    await until(() => calls >= 6);
    // The initial empty Map plus the first real one = 2 distinct references, never more.
    expect(r.lastFrame()).toBe("refs:2:size:1");
    rows = [ROW("acme/api"), ROW("beta/two")];
    await until(() => r.lastFrame() === "refs:3:size:2");
    r.unmount();
  });
});
