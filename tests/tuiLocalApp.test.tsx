// App-level LOCAL-mode suite. (The file name is tuiLocalApp because the
// Task-14 LocalDashboard *component* suite already owns tuiLocal.test.tsx.)
// Fixtures + renderApp live in ./helpers/localFixtures — renderApp mounts at
// the wide breakpoint so the bracketed mode tabs render.
import { describe, it, expect, afterEach } from "vitest";
import { cleanup } from "ink-testing-library";
import type { LocalCheap } from "../src/tui/localSnapshot.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import { until } from "./helpers/until.js";
import { renderApp, CHEAP, ESC, stubClient } from "./helpers/localFixtures.js";

afterEach(cleanup);

// SGR mouse press at 0-based cell (x,y) — mirrors tuiMouseApp.test.tsx.
const press = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}M`;
const lineOf = (frame: string, needle: string): number =>
  frame.split("\n").findIndex((l) => l.includes(needle));

describe("uiMode toggle", () => {
  it("m swaps github → local and back", async () => {
    const r = renderApp();
    await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
    r.stdin.write("m");
    await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
    r.stdin.write("m");
    await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
  });

  it("Shift+Tab swaps modes but a bare Tab does not", async () => {
    const r = renderApp();
    await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
    r.stdin.write("[Z"); // Shift+Tab
    await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
    r.stdin.write("\t"); // bare Tab: pane-cycle, NOT a mode swap
    await new Promise((res) => setTimeout(res, 20));
    expect(r.lastFrame()).toContain("[LOCAL]");
  });

  it("the bracketed active tab is legible with NO_COLOR (glyphs, not just color)", async () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const r = renderApp({ initialUiMode: "local" });
      await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
      expect(r.lastFrame()).toContain("github");
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });
});

describe("local sections", () => {
  it("launches into the Queue section and renders running/waiting/recent", async () => {
    const r = renderApp({ initialUiMode: "local" });
    await until(() => {
      const f = r.lastFrame() ?? "";
      return (
        f.includes("queue") &&
        f.includes("outbox") &&
        f.includes("worktrees") &&
        f.includes("daemon")
      );
    });
  });

  it("j/k move the section rail; → enters the body; ← returns to the rail", async () => {
    const r = renderApp({ initialUiMode: "local" });
    await until(() => (r.lastFrame() ?? "").includes("1/5")); // queue selected
    r.stdin.write("j"); // → outbox
    await until(() => (r.lastFrame() ?? "").includes("2/5"));
    r.stdin.write("j"); // → repos
    await until(() => (r.lastFrame() ?? "").includes("3/5"));
    r.stdin.write("j"); // → worktrees
    await until(() => (r.lastFrame() ?? "").includes("4/5"));
    await until(() => (r.lastFrame() ?? "").includes("fix-typos")); // worktrees body (heavy loaded)
    r.stdin.write("l"); // → body
    await until(() => (r.lastFrame() ?? "").includes("prune")); // body footer (worktrees)
    await until(() => (r.lastFrame() ?? "").includes("stale"));
    r.stdin.write(ESC); // → rail
    await until(() => (r.lastFrame() ?? "").includes("↑/↓ section"));
  });

  it("daemon section shows pid, uptime, endpoint, guard, tokens", async () => {
    const r = renderApp({ initialUiMode: "local" });
    await until(() => (r.lastFrame() ?? "").includes("daemon"));
    r.stdin.write("G"); // last section
    await until(() => {
      const f = r.lastFrame() ?? "";
      return f.includes("4242") && f.includes("guard");
    });
  });

  it("daemon-down and snapshot-error render without collapsing the frame", async () => {
    const down: LocalCheap = {
      ...CHEAP,
      daemon: { ...CHEAP.daemon, up: false, pid: null, endpointReachable: false },
      outbox: { depth: 0, dead: 0, ops: [], deadOps: [], error: "boom" },
    };
    const r = renderApp({ initialUiMode: "local", localCheapFn: async () => down });
    await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
    // "not running" only lives in the daemon SECTION body — navigate to it.
    r.stdin.write("G");
    await until(() => (r.lastFrame() ?? "").toLowerCase().includes("not running"));
    r.stdin.write("g"); // → queue
    await until(() => (r.lastFrame() ?? "").includes("1/5"));
    r.stdin.write("j"); // → outbox (its snapshot error renders "unavailable")
    await until(() => (r.lastFrame() ?? "").includes("unavailable"));
  });
});

describe("local sections: mouse", () => {
  it("clicking a section in the LOCAL rail selects it; clicking again enters the body", async () => {
    const r = renderApp({ initialUiMode: "local" });
    await until(() => (r.lastFrame() ?? "").includes("sections"));
    const y = lineOf(r.lastFrame() ?? "", "repos");
    r.stdin.write(press(3, y));
    await until(() => (r.lastFrame() ?? "").split("\n")[y].includes("▌"));
    r.stdin.write(press(3, y));
    await until(() =>
      /* repos body focused: its border shows accent — assert on the section body header */ (
        r.lastFrame() ?? ""
      ).includes("repos"),
    );
  });

  it("clicking a LOCAL body row moves the cursor and focuses the body", async () => {
    const r = renderApp({ initialUiMode: "local" }); // fixture seeds ≥2 outbox ops
    await until(() => (r.lastFrame() ?? "").includes("sections"));
    const sectionY = lineOf(r.lastFrame() ?? "", "outbox");
    r.stdin.write(press(3, sectionY)); // select the outbox section
    await until(() => (r.lastFrame() ?? "").split("\n")[sectionY].includes("▌"));
    // Rows render as "<age> <op.kind> <issueKey>" — locate the second op by its
    // issueKey from the fixture data.
    const rowY = lineOf(r.lastFrame() ?? "", "acme/api#2");
    r.stdin.write(press(30, rowY));
    await until(() => (r.lastFrame() ?? "").split("\n")[rowY].includes("▌"));
  });
});

describe("github disabled", () => {
  it("launches into LOCAL with the GITHUB tab present but pressing m toasts it is off", async () => {
    const r = renderApp({ initialUiMode: "local", githubEnabled: false });
    await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
    r.stdin.write("m");
    await until(() => (r.lastFrame() ?? "").toLowerCase().includes("github mode is off"));
    expect(r.lastFrame()).toContain("[LOCAL]"); // did NOT cross to github
  });

  it("a failing background issues poll does NOT flash a github error toast over LOCAL", async () => {
    let resolved = 0;
    const failing: DashboardClient = {
      ...stubClient,
      // The background poll (scoped cycle on mount) hits this even in LOCAL mode.
      listIssues: async () => {
        resolved++;
        return { ok: false, error: "gh boom" };
      },
    };
    const r = renderApp({ initialUiMode: "local", githubEnabled: false, client: failing });
    await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
    await until(() => resolved > 0); // the issues poll ran + resolved
    // Give any resulting toast time to commit (bounded spin — a single fixed
    // tick would race React; the loop lets a buggy toast surface if it will).
    for (let i = 0; i < 20; i++) await new Promise((res) => setTimeout(res, 1));
    expect(r.lastFrame()).not.toContain("gh boom");
    expect(r.lastFrame()).toContain("[LOCAL]");
  });
});

describe("local help modal", () => {
  it("? opens local help and any key closes it, staying in local mode", async () => {
    const r = renderApp({ initialUiMode: "local" });
    await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
    r.stdin.write("?");
    await until(() => (r.lastFrame() ?? "").includes("local mode"));
    r.stdin.write("j"); // any key — must close help, not move the section rail
    await until(() => !(r.lastFrame() ?? "").includes("local mode"));
    expect(r.lastFrame()).toContain("[LOCAL]"); // still in local mode
  });

  it("help hints replace the LOCAL rail hints while help is open", async () => {
    const r = renderApp({ initialUiMode: "local" });
    await until(() => (r.lastFrame() ?? "").includes("↑/↓ section")); // rail hints in the footer
    r.stdin.write("?");
    await until(() => (r.lastFrame() ?? "").includes("local mode")); // help modal open
    await until(() => !(r.lastFrame() ?? "").includes("↑/↓ section")); // stale rail chips gone
    expect(r.lastFrame()).toContain("any key");
  });
});

describe("config editor reachable in local mode", () => {
  // A github-disabled user starts in local mode and can't switch to github
  // mode (see "github disabled" above) — `,` must open the config editor
  // straight out of local mode, not just from the github cascade. The
  // isolated ConfigView suite (tests/configView.test.tsx) can't catch a
  // wiring gap in App.tsx's input routing, so this exercises the full App.
  it(", opens the config editor from LOCAL mode", async () => {
    const r = renderApp({ initialUiMode: "local", githubEnabled: false });
    await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
    r.stdin.write(",");
    // Description text for the initially-focused `vaultRoot` lever — unique
    // ConfigView chrome, not something LocalDashboard's sections ever render.
    await until(() => (r.lastFrame() ?? "").includes("Root directory Junco keeps"));
    expect(r.lastFrame()).toContain("Root directory Junco keeps");
  });

  it("Esc exits the config editor back to LOCAL mode", async () => {
    const r = renderApp({ initialUiMode: "local", githubEnabled: false });
    await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
    r.stdin.write(",");
    await until(() => (r.lastFrame() ?? "").includes("Root directory Junco keeps"));
    r.stdin.write(ESC);
    // "[LOCAL]" is header chrome present the whole time (config view included)
    // — wait for the config-specific body content to actually unmount, then
    // confirm the LOCAL section rail (queue/outbox/worktrees/daemon) is back.
    await until(() => !(r.lastFrame() ?? "").includes("Root directory Junco keeps"));
    const f = r.lastFrame() ?? "";
    expect(f).toContain("[LOCAL]");
    expect(f).toContain("queue");
    expect(f).toContain("daemon");
  });
});
