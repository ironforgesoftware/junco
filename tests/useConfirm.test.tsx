// tests/useConfirm.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useConfirm } from "../src/tui/hooks/useConfirm.js";
import { until } from "./helpers/until.js";

function Probe({ onReady }: { onReady: (api: ReturnType<typeof useConfirm>) => void }) {
  const api = useConfirm();
  onReady(api);
  return <Text>{api.confirm ? `${api.confirm.title}:${api.confirm.body}` : "none"}</Text>;
}

describe("useConfirm", () => {
  it("starts null, askConfirm sets it, a cancel answer clears it", async () => {
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

    // A cancel drops the state without invoking onConfirm (no onCancel given).
    api.settle("cancel");
    await until(() => r.lastFrame() === "none");
    expect(confirmed).toBe(false);

    r.unmount();
  });

  // A held `y` reaches App's cascade as a replayed run inside ONE render
  // closure (useGuardedInput), where `confirm` is still the open modal for
  // every replay — so the answer has to latch in the hook, not the closure.
  it("settle fires the answer once per opening, whichever way it is asked", async () => {
    let api!: ReturnType<typeof useConfirm>;
    const r = render(<Probe onReady={(a) => (api = a)} />);
    const fired: string[] = [];
    api.askConfirm({
      title: "Delete",
      body: "sure?",
      danger: true,
      onConfirm: () => fired.push("confirm"),
      onCancel: () => fired.push("cancel"),
    });
    await until(() => r.lastFrame() === "Delete:sure?");
    api.settle("confirm");
    api.settle("confirm"); // the second replay of the run
    api.settle("cancel"); // and a stray esc in the same closure
    await until(() => r.lastFrame() === "none");
    expect(fired).toEqual(["confirm"]);

    // Re-armed by the next opening; cancel fires onCancel exactly once too.
    api.askConfirm({ title: "Again", body: "b", danger: false, onConfirm: () => fired.push("c2") });
    await until(() => r.lastFrame() === "Again:b");
    api.settle("cancel");
    api.settle("cancel");
    await until(() => r.lastFrame() === "none");
    expect(fired).toEqual(["confirm"]); // no onCancel given: nothing more fired
    api.settle("confirm"); // nothing open: inert
    expect(fired).toEqual(["confirm"]);
    r.unmount();
  });
});
