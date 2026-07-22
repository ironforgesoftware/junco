// tests/useToast.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useToast } from "../src/tui/hooks/useToast.js";

function Probe({ onReady }: { onReady: (api: ReturnType<typeof useToast>) => void }) {
  const api = useToast();
  onReady(api);
  return <Text>{api.toast ? `${api.toast.kind}:${api.toast.text}` : "none"}</Text>;
}

describe("useToast", () => {
  it("shows then the state reflects it, and dismiss clears", async () => {
    let api!: ReturnType<typeof useToast>;
    const r = render(<Probe onReady={(a) => (api = a)} />);
    expect(r.lastFrame()).toBe("none");
    api.showToast("info", "hi");
    await new Promise((res) => setTimeout(res, 5));
    expect(r.lastFrame()).toBe("info:hi");
    api.dismissToast();
    await new Promise((res) => setTimeout(res, 5));
    expect(r.lastFrame()).toBe("none");
    r.unmount();
  });
});
