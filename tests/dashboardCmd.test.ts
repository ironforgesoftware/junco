import { describe, it, expect } from "vitest";
import { runDashboard } from "../src/dashboardCmd.js";
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
  },
} as unknown as Config;

describe("runDashboard", () => {
  it("non-TTY exits 1 with guidance and never renders", async () => {
    let rendered = false;
    const errs: string[] = [];
    const code = await runDashboard(cfg, "/x/config.toml", {
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
    const code = await runDashboard(cfg, "/x/config.toml", {
      isTTY: true,
      renderFn: () => {
        rendered = true;
        return { waitUntilExit: async () => {} };
      },
    });
    expect(code).toBe(0);
    expect(rendered).toBe(true);
  });

  // Fix 4: the bridge never sweeps when github.enabled=false, so dispatches from
  // the UI would sit forever. Refuse to launch a live-looking dashboard.
  it("github.enabled=false exits 1 with guidance and never renders", async () => {
    const disabled = {
      ...cfg,
      github: { ...cfg.github, enabled: false },
    } as unknown as Config;
    let rendered = false;
    const errs: string[] = [];
    const code = await runDashboard(disabled, "/x/config.toml", {
      isTTY: true,
      renderFn: () => {
        rendered = true;
        return { waitUntilExit: async () => {} };
      },
      printErr: (s) => errs.push(s),
    });
    expect(code).toBe(1);
    expect(rendered).toBe(false);
    expect(errs.join("")).toContain("enabled = false");
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
});
