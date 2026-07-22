// tests/useUpdateCheck.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useUpdateCheck } from "../src/tui/hooks/useUpdateCheck.js";
import type { UpdateInfo } from "../src/updateCheck.js";
import { until } from "./helpers/until.js";

function Probe({ fn }: { fn?: () => Promise<UpdateInfo | null> }) {
  const updateLatest = useUpdateCheck(fn);
  return <Text>{updateLatest ?? "none"}</Text>;
}

describe("useUpdateCheck", () => {
  it("fetches once on mount and reflects the newer version in state", async () => {
    const fn = async (): Promise<UpdateInfo | null> => ({
      current: "1.0.0",
      latest: "9.9.9",
      available: true,
    });
    const r = render(<Probe fn={fn} />);
    expect(r.lastFrame()).toBe("none");
    await until(() => r.lastFrame() === "9.9.9");
    r.unmount();
  });

  it("stays null when checkUpdateFn is absent", async () => {
    const r = render(<Probe />);
    // Give any (incorrectly) scheduled async work a chance to resolve before
    // asserting the negative — there is nothing to poll toward here.
    await new Promise((res) => setTimeout(res, 20));
    expect(r.lastFrame()).toBe("none");
    r.unmount();
  });
});
