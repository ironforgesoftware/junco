// #455: the dashboard has several `void asyncVerb()` call sites. Ruling R34 in
// the #445 review made every CURRENT verb catch-and-toast, so none can reject —
// but there was no process-level net, and on Node 22 an unhandled rejection is
// a process exit: for a full-screen Ink app, a hard quit with no message.
import { describe, it, afterEach, expect } from "vitest";
import { cleanup } from "ink-testing-library";
import { until, wait } from "./helpers/until.js";
import { renderApp, stubClient, tap } from "./helpers/localFixtures.js";
import type { DashboardClient } from "../src/tui/ghClient.js";

afterEach(cleanup);

/** Detach every `unhandledRejection` listener registered so far — vitest's own
 * reporter among them, which would fail the file for the very error the
 * dashboard exists to swallow. Call BEFORE mounting App: the listener App
 * installs at mount is what these specs are here to exercise, so it must not
 * be in the detached set. Returns the restore. */
function detachForeignListeners(): () => void {
  const foreign = process.listeners("unhandledRejection");
  for (const l of foreign) process.off("unhandledRejection", l);
  return () => {
    for (const l of foreign) process.on("unhandledRejection", l);
  };
}

describe("dashboard unhandledRejection net (#455)", () => {
  it("a rejecting injected action toasts instead of tearing the App down", async () => {
    const restore = detachForeignListeners();
    try {
      const client: DashboardClient = {
        ...stubClient,
        // The R34 contract violation the net exists for: a client method that
        // REJECTS instead of returning `ok: false`. App's runAction fires it as
        // `void client.applyAction(...).then(...)`, so the rejection escapes.
        applyAction: () => Promise.reject(new Error("boom")),
      };
      const r = renderApp({ client });
      await until(() => (r.lastFrame() ?? "").includes("First issue"));
      await tap(r, "l"); // rail → issues pane
      await until(() => (r.lastFrame() ?? "").includes("First issue"));
      await tap(r, "m"); // "import" == runAction("dispatch")

      await until(() => (r.lastFrame() ?? "").includes("internal error: boom"));
      // Still mounted and still painting the surface — not a hard quit.
      expect(r.lastFrame() ?? "").toContain("First issue");
    } finally {
      restore();
    }
  });

  it("the listener is scoped to the mount — no cross-talk after unmount", async () => {
    const restore = detachForeignListeners();
    try {
      const r = renderApp();
      await until(() => (r.lastFrame() ?? "").includes("First issue"));
      expect(process.listenerCount("unhandledRejection")).toBe(1);
      r.unmount();
      await wait(20);
      expect(process.listenerCount("unhandledRejection")).toBe(0);
    } finally {
      restore();
    }
  });
});
