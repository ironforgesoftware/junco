// tests/useConfirm.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useConfirm } from "../src/tui/hooks/useConfirm.js";

function Probe({ onReady }: { onReady: (api: ReturnType<typeof useConfirm>) => void }) {
  const api = useConfirm();
  onReady(api);
  return <Text>{api.confirm ? `${api.confirm.title}:${api.confirm.body}` : "none"}</Text>;
}

describe("useConfirm", () => {
  it("starts null, askConfirm sets it, clearConfirm clears it", async () => {
    let api!: ReturnType<typeof useConfirm>;
    const r = render(<Probe onReady={(a) => (api = a)} />);
    expect(r.lastFrame()).toBe("none");
    expect(api.confirm).toBeNull();

    let confirmed = false;
    api.askConfirm({
      title: "Delete branch",
      body: "This cannot be undone.",
      danger: true,
      onConfirm: () => {
        confirmed = true;
      },
    });
    await new Promise((res) => setTimeout(res, 5));
    expect(r.lastFrame()).toBe("Delete branch:This cannot be undone.");
    expect(api.confirm?.danger).toBe(true);

    // clearConfirm drops the state without invoking onConfirm.
    api.clearConfirm();
    await new Promise((res) => setTimeout(res, 5));
    expect(r.lastFrame()).toBe("none");
    expect(confirmed).toBe(false);

    r.unmount();
  });
});
