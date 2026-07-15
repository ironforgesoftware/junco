import { describe, it, expect } from "vitest";
import { runDashboard, INK_RENDER_OPTIONS } from "../src/dashboardCmd.js";
import type { Config } from "../src/types.js";

const cfg = {
  stateDir: "/tmp/junco-dash-test",
  vaultRoot: "/tmp/junco-dash-test-vault",
  juncoSubdir: "Junco",
  maxConcurrent: 1,
  healthEnabled: false,
  healthHost: "127.0.0.1",
  healthPort: 0,
  github: {
    enabled: true,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: 60,
    repos: [],
    requireApproval: true,
    plannerModelId: null,
    externalReposRoot: "/tmp/junco-test-external",
  },
} as unknown as Config;

describe("runDashboard", () => {
  it("non-TTY exits 1 with guidance and never renders", async () => {
    let rendered = false;
    const errs: string[] = [];
    const code = await runDashboard(cfg, "/x/config.json", {
      isTTY: false,
      renderFn: () => {
        rendered = true;
        return { waitUntilExit: async () => {} };
      },
      printErr: (s) => errs.push(s),
    });
    expect(code).toBe(1);
    expect(rendered).toBe(false);
    expect(errs.join("")).toContain("junco list");
  });

  it("TTY renders and resolves when the app exits", async () => {
    let rendered = false;
    const code = await runDashboard(cfg, "/x/config.json", {
      isTTY: true,
      renderFn: () => {
        rendered = true;
        return { waitUntilExit: async () => {} };
      },
    });
    expect(code).toBe(0);
    expect(rendered).toBe(true);
  });

  // LOCAL mode: with the GitHub bridge off, the dashboard now launches straight
  // into the local surface instead of refusing — Task 18 relaxes the old
  // Fix-4 refusal now that there's a non-GitHub UI to land on.
  it("github.enabled=false launches into LOCAL mode (renders) rather than refusing", async () => {
    const disabled = {
      ...cfg,
      github: { ...cfg.github, enabled: false },
    } as unknown as Config;
    let rendered = false;
    const errs: string[] = [];
    const code = await runDashboard(disabled, "/x/config.json", {
      isTTY: true,
      renderFn: () => {
        rendered = true;
        return { waitUntilExit: async () => {} };
      },
      printErr: (s) => errs.push(s),
    });
    expect(code).toBe(0);
    expect(rendered).toBe(true);
    expect(errs.join("")).not.toContain("enabled = false");
  });

  it("still refuses when there is no TTY, regardless of github.enabled", async () => {
    const disabled = {
      ...cfg,
      github: { ...cfg.github, enabled: false },
    } as unknown as Config;
    let rendered = false;
    const code = await runDashboard(disabled, "/x/config.json", {
      isTTY: false,
      renderFn: () => {
        rendered = true;
        return { waitUntilExit: async () => {} };
      },
    });
    expect(code).toBe(1);
    expect(rendered).toBe(false);
  });
});

describe("runDashboard FTUE (nullable config)", () => {
  it("non-TTY with a null config exits 1 and points at `config init`", async () => {
    let rendered = false;
    const errs: string[] = [];
    const code = await runDashboard(null, "/x/config.json", {
      isTTY: false,
      renderFn: () => {
        rendered = true;
        return { waitUntilExit: async () => {} };
      },
      printErr: (s) => errs.push(s),
    });
    expect(code).toBe(1);
    expect(rendered).toBe(false);
    expect(errs.join("")).toContain("config init");
  });

  it("TTY with a null config renders the Root element without throwing", async () => {
    let el: unknown = null;
    const code = await runDashboard(null, "/x/config.json", {
      isTTY: true,
      renderFn: (element) => {
        el = element;
        return { waitUntilExit: async () => {} };
      },
    });
    expect(code).toBe(0);
    expect(el).not.toBeNull();
  });

  // Amendment 1 — truthful cancel message: the wizard renames the config into
  // place before a throwable re-read, so a user CAN cancel with the file
  // already on disk. runDashboard existence-checks at print time.
  it("FTUE cancel with NO file on disk prints the truthful 'nothing written' message", async () => {
    const outs: string[] = [];
    const code = await runDashboard(null, "/x/config.json", {
      isTTY: true,
      existsFn: () => false,
      printOut: (s) => outs.push(s),
      renderFn: (element) => {
        // Root is the MouseProvider's child; fire its FTUE-cancel callback.
        (
          element.props as { children: { props: { onFinalExitCode: (n: number) => void } } }
        ).children.props.onFinalExitCode(130);
        return { waitUntilExit: async () => {} };
      },
    });
    expect(code).toBe(130);
    expect(outs.join("")).toContain("nothing written");
    expect(outs.join("")).not.toContain("junco doctor");
  });

  it("FTUE cancel with a file ALREADY on disk prints the truthful 'config exists' message", async () => {
    const outs: string[] = [];
    const code = await runDashboard(null, "/x/config.json", {
      isTTY: true,
      existsFn: () => true,
      printOut: (s) => outs.push(s),
      renderFn: (element) => {
        (
          element.props as { children: { props: { onFinalExitCode: (n: number) => void } } }
        ).children.props.onFinalExitCode(130);
        return { waitUntilExit: async () => {} };
      },
    });
    expect(code).toBe(130);
    expect(outs.join("")).toContain("a config exists at");
    expect(outs.join("")).toContain("junco doctor");
  });
});

describe("lazy loading discipline", () => {
  it("cli.ts reaches the dashboard only through a dynamic import", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(src).toContain('await import("./dashboardCmd.js")');
    expect(src).not.toMatch(/^import .* from "\.\/dashboardCmd\.js"/m);
    expect(src).not.toMatch(/from "ink"/);
  });

  it("renders the dashboard on the alternate screen buffer (fullscreen)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/dashboardCmd.ts", import.meta.url), "utf8");
    expect(src).toContain("alternateScreen: true");
  });
});

// The dashboard hosts the setup walkthrough inside ONE Ink render. ink 7.1.0's
// use-input.js SKIPS every registered useInput handler for Ctrl-C when
// exitOnCtrlC is true and exits directly ("If app is supposed to exit on
// Ctrl+C, skip input listeners"). That would make WizardApp's Ctrl-C branch
// dead (a post-write Ctrl-C could no longer report written/unchanged) and an
// FTUE cancel could never report 130 through onOutcome → onFinalExitCode. The
// host therefore renders with exitOnCtrlC:false; the App installs its own
// Ctrl-C quit handler (see tests/tuiApp.test.tsx). ink-testing-library
// hardcodes exitOnCtrlC:false, so this constant is the ONLY place the
// production value is asserted — the test library can't observe it for us.
describe("INK_RENDER_OPTIONS (Ctrl-C must reach the hosted wizard/App handlers)", () => {
  it("disables ink's built-in exitOnCtrlC so useInput handlers see Ctrl-C", () => {
    expect(INK_RENDER_OPTIONS.exitOnCtrlC).toBe(false);
  });
  it("keeps the fullscreen alternate-screen buffer", () => {
    expect(INK_RENDER_OPTIONS.alternateScreen).toBe(true);
  });

  it("localSnapshot factories are pulled through the same lazy Promise.all", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/dashboardCmd.ts", import.meta.url), "utf8");
    expect(src).toContain('import("./tui/localSnapshot.js")');
    expect(src).toContain("makeLocalCheapFn");
    expect(src).toContain("makeLocalHeavyFn");
  });
});
