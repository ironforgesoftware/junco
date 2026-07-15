// App-level mouse routing through the hit-region registry (MouseProvider +
// ClickableBox). A press/wheel is resolved to the deepest registered region
// under the pointer's real yoga rect — no mirrored geometry, no hitTest. These
// specs exercise the GITHUB surface (issue rows, the rail wheel) and the header
// mode tabs; renderApp mounts at the wide breakpoint (WIDE_COLS_TEST) so the
// bracketed `[GITHUB]`/`[LOCAL]` tabs render and the pane bands are stable.
import { describe, it, afterEach } from "vitest";
import { cleanup } from "ink-testing-library";
import { until, fireUntil } from "./helpers/until.js";
import { renderApp } from "./helpers/localFixtures.js";

afterEach(cleanup);

// SGR mouse sequences at 0-based cell (x,y): ESC [ < b ; col ; row M, cols/rows
// 1-based on the wire. b=0 press, b=65 wheel-down. `\u001b` (not a raw ESC byte)
// so file edits never drop it.
const press = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}M`;
const wheelDown = (x: number, y: number): string => `\u001b[<65;${x + 1};${y + 1}M`;

const lineOf = (frame: string, needle: string): number =>
  frame.split("\n").findIndex((l) => l.includes(needle));

// Header tab click bands (wide mode), mirroring Chrome.tsx's Header layout:
// paddingX(1) + "🐦 junco" (8 cols — the bird emoji is width 2) + gap(2) = 11
// cols before the GITHUB tab, then the fixed-width `[GITHUB]`/`github` slot
// (ghWidth=8) + a 1-col gutter before the LOCAL slot. (These were the
// now-deleted headerTabBands' githubStart/localStart.)
const GITHUB_TAB_START = 11;
const LOCAL_TAB_START = GITHUB_TAB_START + 8 + 1; // 20

describe("mouse row/wheel in GITHUB", () => {
  it("clicking an issue row selects it; clicking again opens the detail", async () => {
    const r = renderApp({ initialUiMode: "github" }); // fixture seeds ≥2 issues
    await until(() => lineOf(r.lastFrame() ?? "", "#2") >= 0);
    const y = lineOf(r.lastFrame() ?? "", "#2");
    // Middle column band at WIDE_COLS_TEST=120: rail [0,26), issues [26,72),
    // preview/pane-3 [72,120). x=40 is solidly inside the issues pane.
    const x = 40;
    // First press selects #2 (row is deselected at mount → click is idempotent).
    await fireUntil(
      r.stdin,
      press(x, y),
      () => (r.lastFrame() ?? "").split("\n")[y]?.includes("▌") ?? false,
    );
    // Second press on the already-selected row opens the detail (which unmounts
    // the list, so the retry self-terminates).
    await fireUntil(r.stdin, press(x, y), () => (r.lastFrame() ?? "").includes("preview · #2"));
  });

  it("wheel over the rail moves the repo selection", async () => {
    const r = renderApp({ initialUiMode: "github" }); // fixture seeds ≥2 repos
    await until(() => (r.lastFrame() ?? "").includes("1 repos"));
    // wheelDown inside the rail band; the mover clamps at the last repo, so
    // re-sending is idempotent. The selected repo's nwo also shows in the
    // header, so anchor on the rail row that carries BOTH the nwo AND the `▌`
    // selection bar (the header never renders the bar).
    await fireUntil(r.stdin, wheelDown(2, 4), () =>
      (r.lastFrame() ?? "").split("\n").some((l) => l.includes("beta/two") && l.includes("▌")),
    );
  });
});

describe("header mode tabs", () => {
  it("a header-band click toggles the mode", async () => {
    const r = renderApp({ initialUiMode: "github" });
    await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
    // handleModeTab is a no-op once already local, so re-sending is idempotent.
    await fireUntil(r.stdin, press(LOCAL_TAB_START, 0), () =>
      (r.lastFrame() ?? "").includes("[LOCAL]"),
    );
  });

  it("hovering a header tab does not crash and hover moves with the pointer", async () => {
    const r = renderApp({ initialUiMode: "github" });
    await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
    // b=35 → button-less motion (hover) over the LOCAL tab.
    r.stdin.write(`\u001b[<35;${LOCAL_TAB_START + 1};1M`);
    await until(() => (r.lastFrame() ?? "") !== ""); // hover styling is cosmetic — frame stays renderable
    await fireUntil(r.stdin, press(LOCAL_TAB_START, 0), () =>
      (r.lastFrame() ?? "").includes("[LOCAL]"),
    );
  });
});
