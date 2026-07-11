import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, type DoctorDeps } from "../src/doctor.js";
import { writeWatchlist } from "../src/watchlist.js";
import { outboxPaths } from "../src/githubOutbox.js";
import { writePending } from "../src/assessReview.js";
import { writeDraft } from "../src/commentReview.js";
import type { Config } from "../src/types.js";

const okConfig = {
  model: { id: "local/m", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "k", modelsJson: null },
  vaultRoot: "/tmp/junco-doc-vault",
  juncoSubdir: "",
  worktreeRoot: "/tmp/junco-doc-wt",
  stateDir: "/tmp/junco-doc-state",
  gitBin: "git",
  ghBin: "gh",
  github: {
    enabled: false,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: 60,
    repos: [],
    requireApproval: true,
    plannerModelId: null,
    externalReposRoot: "/tmp/junco-test-external",
  },
} as unknown as Config;

/** okConfig with the bridge enabled and the given repo mappings. */
function githubConfig(repos: { nwo: string; path: string }[]): Config {
  return {
    ...okConfig,
    github: { ...okConfig.github, enabled: true, repos },
  } as Config;
}

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    loadConfigFn: () => okConfig,
    execFn: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    reachableFn: async () => true,
    fetchModelsFn: async () => ["m"],
    accessOkFn: () => true,
    lockHolderFn: () => null,
    printFn: () => {},
    ...over,
  };
}

describe("runDoctor", () => {
  it("all green → exit 0", async () => {
    expect(await runDoctor("/x/config.toml", deps())).toBe(0);
  });

  it("unreachable endpoint → ✗ and exit 1", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({ reachableFn: async () => false, printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/✗ inference endpoint/);
    expect(lines.join("")).toMatch(/NOT ready/);
  });

  it("does not report sandbox when disabled (default)", async () => {
    const lines: string[] = [];
    await runDoctor("/x/config.toml", deps({ printFn: (s) => lines.push(s) }));
    expect(lines.join("")).not.toMatch(/sandbox/i);
  });

  it("reports ✓ when the enabled sandbox backend is available", async () => {
    const lines: string[] = [];
    const cfg = {
      ...okConfig,
      sandbox: {
        enabled: true,
        backend: "bwrap",
        network: "deny",
        extraDenyRead: [],
        extraAllowWrite: [],
      },
    } as unknown as Config;
    await runDoctor(
      "/x/config.toml",
      deps({ loadConfigFn: () => cfg, printFn: (s) => lines.push(s) }),
    );
    expect(lines.join("")).toMatch(/✓ sandbox/);
  });

  it("reports ✗ and fails when the enabled sandbox backend is unavailable", async () => {
    const lines: string[] = [];
    const cfg = {
      ...okConfig,
      sandbox: {
        enabled: true,
        backend: "bwrap",
        network: "deny",
        extraDenyRead: [],
        extraAllowWrite: [],
      },
    } as unknown as Config;
    const code = await runDoctor(
      "/x/config.toml",
      deps({
        loadConfigFn: () => cfg,
        // bwrap probe fails (127); other checks pass.
        execFn: async (cmd: string) =>
          cmd === "bwrap"
            ? { code: 127, stdout: "", stderr: "not found" }
            : { code: 0, stdout: "ok", stderr: "" },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/✗ sandbox/);
  });

  it("missing gh is a warning, not a failure (Q&A-only setups are valid)", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({
        execFn: async (cmd: string) =>
          cmd === "gh"
            ? { code: 127, stdout: "", stderr: "not found" }
            : { code: 0, stdout: "ok", stderr: "" },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ gh/);
  });

  it("gh installed but unauthenticated → warning with the login hint", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({
        execFn: async (_cmd: string, args: string[]) =>
          args[0] === "auth"
            ? { code: 1, stdout: "", stderr: "not logged in" }
            : { code: 0, stdout: "ok", stderr: "" },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/gh auth login/);
  });

  it("unparseable config → ✗ and exit 1, later checks skipped", async () => {
    const code = await runDoctor(
      "/x/config.toml",
      deps({
        loadConfigFn: () => {
          throw new Error("bad toml");
        },
      }),
    );
    expect(code).toBe(1);
  });

  it("model missing from the endpoint listing → warning only", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({ fetchModelsFn: async () => ["other"], printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ model/);
  });

  it("unwritable queue dir → ✗ and exit 1", async () => {
    const code = await runDoctor("/x/config.toml", deps({ accessOkFn: () => false }));
    expect(code).toBe(1);
  });

  it("running daemon is reported informationally", async () => {
    const lines: string[] = [];
    await runDoctor(
      "/x/config.toml",
      deps({ lockHolderFn: () => 4242, printFn: (s) => lines.push(s) }),
    );
    expect(lines.join("")).toMatch(/✓ daemon — running \(pid 4242\)/);
  });

  it("warns on a non-loopback health_host, does not fail doctor (#44)", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({
        loadConfigFn: () =>
          ({ ...okConfig, healthEnabled: true, healthHost: "0.0.0.0" }) as unknown as Config,
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ health bind/);
    expect(lines.join("")).toMatch(/0\.0\.0\.0/);
  });

  it("warns on an empty health_host that bypassed normalization (#71)", async () => {
    // "" binds all interfaces; the old `&& cfg.healthHost` guard evaded the warn.
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({
        loadConfigFn: () =>
          ({ ...okConfig, healthEnabled: true, healthHost: "" }) as unknown as Config,
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ health bind/);
  });

  it("no health-bind warning for a loopback health_host (#44)", async () => {
    const lines: string[] = [];
    await runDoctor(
      "/x/config.toml",
      deps({
        loadConfigFn: () =>
          ({ ...okConfig, healthEnabled: true, healthHost: "127.0.0.1" }) as unknown as Config,
        printFn: (s) => lines.push(s),
      }),
    );
    expect(lines.join("")).not.toMatch(/health bind/);
  });
});

describe("runDoctor github checks", () => {
  it("disabled bridge → no github lines at all", async () => {
    const lines: string[] = [];
    await runDoctor("/x/config.toml", deps({ printFn: (s) => lines.push(s) }));
    expect(lines.join("")).not.toMatch(/github/);
  });

  it("warns when enabled with no repos", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({ loadConfigFn: () => githubConfig([]), printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ github — enabled but no repos configured/);
  });

  it("fails a repo whose origin does not match the nwo", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({
        loadConfigFn: () => githubConfig([{ nwo: "acme/api", path: "/tmp/clone" }]),
        execFn: async (_cmd: string, args: string[]) =>
          args.includes("get-url")
            ? { code: 0, stdout: "https://github.com/other/thing.git\n", stderr: "" }
            : { code: 0, stdout: "ok", stderr: "" },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/✗ github repo acme\/api/);
    expect(lines.join("")).toMatch(/other\/thing/);
  });

  it("passes a matching repo reachable via gh", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({
        loadConfigFn: () => githubConfig([{ nwo: "acme/api", path: "/tmp/clone" }]),
        execFn: async (_cmd: string, args: string[]) =>
          args.includes("get-url")
            ? { code: 0, stdout: "git@github.com:acme/api.git\n", stderr: "" }
            : { code: 0, stdout: "ok", stderr: "" },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/✓ github repo acme\/api/);
  });

  it("fails when the dispatch template is unreadable (bridge enabled)", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({
        loadConfigFn: () => githubConfig([]),
        readTemplateFn: () => {
          throw new Error("ENOENT");
        },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/✗ github planner template/);
  });

  it("reports the template ok when readable", async () => {
    const lines: string[] = [];
    await runDoctor(
      "/x/config.toml",
      deps({ loadConfigFn: () => githubConfig([]), printFn: (s) => lines.push(s) }),
    );
    expect(lines.join("")).toMatch(/✓ github planner template/);
  });

  it("fails a repo not reachable via gh", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({
        loadConfigFn: () => githubConfig([{ nwo: "acme/api", path: "/tmp/clone" }]),
        execFn: async (_cmd: string, args: string[]) => {
          if (args.includes("get-url"))
            return { code: 0, stdout: "https://github.com/acme/api.git\n", stderr: "" };
          if (args[0] === "repo" && args[1] === "view")
            return { code: 1, stdout: "", stderr: "not found" };
          return { code: 0, stdout: "ok", stderr: "" };
        },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/✗ github repo acme\/api — not reachable/);
  });

  it("validates watchlist entries alongside config mappings", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-doc-wl-"));
    writeWatchlist(join(stateDir, "github-watchlist.json"), [
      { nwo: "alx/coral", path: "/tmp/coral" },
    ]);
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({
        loadConfigFn: () => ({ ...githubConfig([]), stateDir }) as Config,
        execFn: async (_cmd: string, args: string[]) =>
          args.includes("get-url")
            ? { code: 0, stdout: "https://github.com/alx/coral.git\n", stderr: "" }
            : { code: 0, stdout: "ok", stderr: "" },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toContain("✓ github repo alx/coral");
    expect(lines.join("")).toContain("watchlist");
  });
});

describe("runDoctor outbox checks", () => {
  it("no backlog, no dead-letters → no outbox lines, still ready", async () => {
    const lines: string[] = [];
    const code = await runDoctor("/x/config.toml", deps({ printFn: (s) => lines.push(s) }));
    expect(code).toBe(0);
    expect(lines.join("")).not.toMatch(/outbox/);
  });

  it("warns on a queued backlog (does not fail doctor)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-doc-obx-"));
    const { dir } = outboxPaths({ stateDir } as unknown as Config);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1-a-labels.json"), "{}", "utf8");
    writeFileSync(join(dir, "2-b-labels.json"), "{}", "utf8");
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({ loadConfigFn: () => ({ ...okConfig, stateDir }), printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ outbox backlog — 2 queued \(junco outbox flush\)/);
  });

  it("warns on dead-letters, mentioning the dead/ dir (does not fail doctor)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-doc-obxdead-"));
    const { dead } = outboxPaths({ stateDir } as unknown as Config);
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "1-a-labels.json"), "{}", "utf8");
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({ loadConfigFn: () => ({ ...okConfig, stateDir }), printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ outbox dead-letters/);
    expect(lines.join("")).toContain(dead);
  });
});

describe("runDoctor assess review checks", () => {
  it("no pending reviews → no assess review line", async () => {
    const lines: string[] = [];
    const code = await runDoctor("/x/config.toml", deps({ printFn: (s) => lines.push(s) }));
    expect(code).toBe(0);
    expect(lines.join("")).not.toMatch(/assess review/);
  });

  it("reports pending reviews as informational — not a warning, github disabled", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-doc-review-"));
    writePending({ stateDir } as unknown as Config, {
      id: "a",
      nwo: "o/r",
      external: true,
      autoPlan: false,
      repoPath: "/x",
      createdAt: "2026-07-09T00:00:00.000Z",
      findings: [],
    });
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({ loadConfigFn: () => ({ ...okConfig, stateDir }), printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(0);
    // okConfig has github.enabled = false — the review count must still surface.
    expect(lines.join("")).toMatch(/✓ assess review — 1 pending \(junco assess review\)/);
    expect(lines.join("")).toMatch(/0 warning\(s\)/);
  });
});

describe("runDoctor analyze review checks", () => {
  it("no pending drafts → no analyze drafts line", async () => {
    const lines: string[] = [];
    const code = await runDoctor("/x/config.toml", deps({ printFn: (s) => lines.push(s) }));
    expect(code).toBe(0);
    expect(lines.join("")).not.toMatch(/analyze drafts/);
  });

  it("reports pending drafts as informational — not a warning, github disabled", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-doc-draft-"));
    writeDraft({ stateDir } as unknown as Config, {
      id: "a",
      nwo: "o/r",
      issue: 1,
      issueTitle: "Title",
      external: true,
      repoPath: "/x",
      createdAt: "2026-07-09T00:00:00.000Z",
      draft: "draft body",
      footer: true,
    });
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({ loadConfigFn: () => ({ ...okConfig, stateDir }), printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(0);
    // okConfig has github.enabled = false — the draft count must still surface.
    expect(lines.join("")).toMatch(/✓ analyze drafts — 1 pending \(junco analyze review\)/);
    expect(lines.join("")).toMatch(/0 warning\(s\)/);
  });
});
