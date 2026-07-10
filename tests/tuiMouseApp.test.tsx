// LOCAL-mode mouse routing: the header tab band toggles the mode from any
// view; a body click/wheel in LOCAL is an inert no-op (the body is
// keyboard-first in v1). renderApp mounts at the wide breakpoint, so
// headerTabBands must be queried at that same width for the click to land.
import { describe, it, expect, afterEach } from "vitest";
import { cleanup } from "ink-testing-library";
import { headerTabBands } from "../src/tui/geometry.js";
import { until } from "./helpers/until.js";
import { renderApp, WIDE_COLS_TEST } from "./helpers/localFixtures.js";

afterEach(cleanup);

// SGR mouse press at (x,y): ESC [ < 0 ; col ; row M  (1-based cols/rows).
const press = (x: number, y: number) => `[<0;${x + 1};${y + 1}M`;

describe("mouse in LOCAL", () => {
  it("a body click/wheel is a no-op (no github state mutation, no spawn)", async () => {
    const calls: unknown[] = [];
    const r = renderApp({
      initialUiMode: "local",
      runCliFn: async () => {
        calls.push(1);
        return { code: 0, output: "", timedOut: false };
      },
    });
    await until(() => (r.lastFrame() ?? "").includes("queue"));
    const before = r.lastFrame();
    r.stdin.write(press(40, 5)); // deep in the body
    r.stdin.write("[<64;40;5M"); // wheel code
    await new Promise((res) => setTimeout(res, 20));
    expect(calls).toHaveLength(0);
    expect(r.lastFrame()).toBe(before);
  });

  it("header-band click still toggles the mode", async () => {
    const r = renderApp({ initialUiMode: "github" });
    await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
    // The App resolves the click with headerTabBands(size.columns); query the
    // band at the SAME width the App was mounted at (wide) so localStart lands.
    r.stdin.write(press(headerTabBands(WIDE_COLS_TEST).localStart, 0));
    await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
  });
});
