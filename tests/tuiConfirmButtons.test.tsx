// Confirm-modal buttons: the destructive confirm dialog (App.tsx `confirm`
// state) used to render a dim hint line ("y/enter confirm · n/esc cancel").
// It now renders two clickable Button primitives so a mouse user can act on
// the modal without touching the keyboard — parity with the keyboard layer
// (layer 3 in the input cascade), which stays untouched. Setup mirrors
// tuiLocalActions.test.tsx's "x on a WAITING inbox row confirms" spec exactly:
// rail → queue system row → body focus → cursor on the WAITING row → `D`
// (guarded Delete mnemonic) opens the confirm.
import { describe, it, expect, afterEach } from "vitest";
import { cleanup } from "ink-testing-library";
import { until, fireUntil } from "./helpers/until.js";
import { renderApp, tap, TO_QUEUE_ROW } from "./helpers/localFixtures.js";

afterEach(cleanup);

// SGR mouse press at 0-based cell (x,y) — mirrors tuiMouseApp.test.tsx.
const press = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}M`;

async function openWaitingRowConfirm(r: ReturnType<typeof renderApp>): Promise<void> {
  const frame = (): string => r.lastFrame() ?? "";
  await until(() => frame().includes("system"));
  await tap(r, TO_QUEUE_ROW); // rail → queue system row
  await until(() => frame().includes("sub-fix-typos"));
  r.stdin.write("l"); // enter body — cursor starts on the RUNNING row
  await until(() =>
    frame()
      .split("\n")
      .some((l) => l.includes("#1 exec") && l.includes("▌")),
  );
  r.stdin.write("j"); // down onto the WAITING row
  await until(() =>
    frame()
      .split("\n")
      .some((l) => l.includes("sub-fix-typos") && l.includes("▌")),
  );
  r.stdin.write("D"); // guarded Delete mnemonic — opens confirm (destructive)
  // "delete queued ticket" is the confirm's own title — unlike a bare
  // "delete" substring, it never collides with the footer's persistent
  // "Delete" mnemonic chip (which stays on screen after the modal closes).
  await until(() => frame().includes("delete queued ticket"));
}

describe("confirm modal: clickable buttons", () => {
  it("renders Button primitives instead of the old dim hint line", async () => {
    const r = renderApp();
    await openWaitingRowConfirm(r);
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain("[ esc cancel ]");
    expect(frame).toContain(" y confirm");
    expect(frame).not.toContain("y/enter confirm · n/esc cancel");
  });

  it("clicking the cancel button closes the modal without running the action", async () => {
    const calls: [string, string[]][] = [];
    const r = renderApp({
      runCliFn: async (n, a) => {
        calls.push([n, a]);
        return { code: 0, output: "removed", timedOut: false };
      },
    });
    await openWaitingRowConfirm(r);
    const frame = r.lastFrame() ?? "";
    const lines = frame.split("\n");
    const y = lines.findIndex((l) => l.includes("cancel"));
    const x = (lines[y] ?? "").indexOf("cancel");
    await fireUntil(
      r.stdin,
      press(x, y),
      () => !(r.lastFrame() ?? "").includes("delete queued ticket"),
    );
    expect(calls).toHaveLength(0); // cancel never spawns the CLI
  });
});
