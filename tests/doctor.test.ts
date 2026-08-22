import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, type DoctorDeps } from "../src/doctor.js";
import { writeWatchlist } from "../src/watchlist.js";
import { outboxPaths } from "../src/githubOutbox.js";
import { writePending } from "../src/assessReview.js";
import { writeDraft } from "../src/commentReview.js";
import { recordRun } from "../src/assessHistory.js";
import { WATCHLIST_FILENAME } from "../src/dataTree.js";
import { SKILL_DIR_NAME } from "../src/skillLinks.js";
import type { Config } from "../src/types.js";
import type { ResolvedModelInfo } from "../src/agent/session.js";

const okConfig = {
  model: { id: "local/m", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "k", modelsJson: null },
  // Synthetic, non-existent by construction — NOT /tmp. Several tests below run
  // the real fs against these and assert exact warning counts; with real /tmp
  // paths they passed only because those dirs happened not to exist, and a
  // stray `mkdir /tmp/junco-doc-state/assess-review` turned 4 of them red.
  // Completes the hermeticity fix #199.3 started for two of the tests.
  dataDir: "/sbxroot/junco-doc-state",
  queueRoot: "/sbxroot/junco-doc-vault",
  worktreeRoot: "/sbxroot/junco-doc-wt",
  legacy: {
    vaultRoot: false,
    stateDir: false,
    worktreeRoot: false,
    externalReposRoot: false,
    dataRoot: false,
  },
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
  botAccount: { enabled: false, configDir: "/tmp/junco-doc-gh" },
  // Empty by default — no harness dirs configured, so the 2d skill-links
  // check only ever probes the <dataDir>/skills mount for these fixtures.
  skills: { harnessDirs: [] },
} as unknown as Config;

/** okConfig with the bot account enabled under an isolated GH_CONFIG_DIR. */
function botConfig(over: Partial<Config> = {}): Config {
  return {
    ...okConfig,
    botAccount: { enabled: true, configDir: "/sbx/junco-gh" },
    ...over,
  } as Config;
}

/** okConfig with the bridge enabled and the given repo mappings. */
function githubConfig(repos: { nwo: string; path: string }[]): Config {
  return {
    ...okConfig,
    github: { ...okConfig.github, enabled: true, repos },
  } as Config;
}

/** A hosted catalog model: no local server to probe, apiKey deferred (null). */
function hostedModel() {
  return {
    id: "anthropic/claude-x",
    source: "auto" as const,
    baseUrlExplicit: false,
    modelsJson: null,
    apiKey: null,
    baseUrl: "https://api.anthropic.com/v1",
  };
}

/** A resolveInfoFn success value for a confirmed catalog hit. */
function catalogInfo(over: Partial<ResolvedModelInfo> = {}): ResolvedModelInfo {
  return {
    provider: "anthropic",
    modelId: "claude-x",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    path: "catalog",
    ...over,
  };
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
    // Default to "skipped" (never hits the real network/fs cache) — every
    // pre-existing test that doesn't care about the update check stays
    // hermetic; the version-check describe block below overrides this.
    checkUpdateFn: async () => null,
    // Default existsFn: false for everything except a path ending in
    // "/skills" (the dataTreePaths(cfg).skills mount, at any dataDir a test
    // happens to use — default cfg.skills.harnessDirs is [], so the mount is
    // the only path the 2d skill-links check probes here). This keeps every
    // pre-existing test's skill-links verdict "ok" (silent) by default, the
    // same hermetic-fake-over-real-fs pattern already used for the other
    // existsFn-driven checks in this file — a test that cares about a dead
    // skill link overrides this explicitly (see the skill links describe
    // block below).
    existsFn: (p: string) => p.endsWith("/skills"),
    // Default lstatFn: reports a healthy symlink for the same "/skills"-
    // ending mount path the default existsFn resolves (2d classifies a link
    // as ok only when lstat says symlink AND existsFn says it resolves) —
    // anything else lstats as absent (ENOENT), matching the "dead" verdict
    // default existsFn already implies for it. Mirrors the existsFn carve-out
    // above; a test exercising a specific harness link or a blocked
    // (non-symlink) path overrides this explicitly.
    lstatFn: (p: string) =>
      p.endsWith("/skills")
        ? { isSymbolicLink: () => true }
        : (() => {
            throw new Error("ENOENT");
          })(),
    ...over,
  };
}

describe("runDoctor", () => {
  it("all green → exit 0", async () => {
    // #199.3: inject existsFn/readdirFn so the clean verdict doesn't silently
    // depend on the real fs lacking the /tmp/junco-doc-* fixture paths.
    // "/skills" carve-out keeps the 2d skill-links check silent (ok) too.
    expect(
      await runDoctor(
        "/x/config.json",
        deps({ existsFn: (p: string) => p.endsWith("/skills"), readdirFn: () => [] }),
      ),
    ).toBe(0);
  });

  it("unreachable endpoint → ✗ and exit 1", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({ reachableFn: async () => false, printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/✗ inference endpoint/);
    expect(lines.join("")).toMatch(/NOT ready/);
  });

  it("skips the old reachability probe for hosted catalog configs — resolution echo instead", async () => {
    const lines: string[] = [];
    const cfg = {
      ...okConfig,
      model: { ...hostedModel(), apiKey: "sk-ant-test" },
    } as unknown as Config;
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => cfg,
        resolveInfoFn: async () => catalogInfo(),
        fetchFn: async () => new Response(null, { status: 200 }),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).not.toMatch(/inference endpoint/i);
    expect(lines.join("")).toMatch(/model — anthropic\/claude-x resolves via catalog/i);
  });

  it("reports probe-disabled (not catalog-eligible) when worker.endpointProbe=never on a non-catalog model", async () => {
    const lines: string[] = [];
    // okConfig.model is a LOCAL model (id "local/m") — not catalog-eligible.
    // Probing is skipped here purely because endpointProbe=never overrides
    // the catalog-skip heuristic, so the "catalog-eligible" note would be
    // actively wrong.
    const cfg = { ...okConfig, endpointProbe: "never" } as unknown as Config;
    const code = await runDoctor(
      "/x/config.json",
      deps({ loadConfigFn: () => cfg, printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(
      /inference endpoint.*probe disabled.*worker\.endpointProbe=never/i,
    );
    expect(lines.join("")).not.toMatch(/catalog-eligible/i);
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
      "/x/config.json",
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
      "/x/config.json",
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

  it("reports ⚠ (not ✗) and stays green when backend=auto has no OS backend", async () => {
    const lines: string[] = [];
    const cfg = {
      ...okConfig,
      sandbox: {
        enabled: true,
        backend: "auto",
        network: "deny",
        extraDenyRead: [],
        extraAllowWrite: [],
      },
    } as unknown as Config;
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => cfg,
        // The auto-selected OS backend probe fails (seatbelt on macOS / bwrap on
        // Linux); everything else passes. auto → degrade, not fail-closed.
        execFn: async (cmd: string) =>
          cmd === "bwrap" || cmd === "sandbox-exec"
            ? { code: 127, stdout: "", stderr: "not found" }
            : { code: 0, stdout: "ok", stderr: "" },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0); // degrade does not fail the preflight
    expect(lines.join("")).toMatch(/⚠ sandbox/);
    expect(lines.join("")).toMatch(/degrading to none/);
  });

  it("missing gh is a warning, not a failure (Q&A-only setups are valid)", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
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
      "/x/config.json",
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
      "/x/config.json",
      deps({
        loadConfigFn: () => {
          throw new Error("bad config");
        },
      }),
    );
    expect(code).toBe(1);
  });

  it("model missing from the endpoint listing → warning only", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({ fetchModelsFn: async () => ["other"], printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ model/);
  });

  it("unwritable queue dir → ✗ and exit 1", async () => {
    const code = await runDoctor("/x/config.json", deps({ accessOkFn: () => false }));
    expect(code).toBe(1);
  });

  it("running daemon is reported informationally", async () => {
    const lines: string[] = [];
    await runDoctor(
      "/x/config.json",
      deps({ lockHolderFn: () => 4242, printFn: (s) => lines.push(s) }),
    );
    expect(lines.join("")).toMatch(/✓ daemon — running \(pid 4242\)/);
  });

  it("warns on a non-loopback health_host, does not fail doctor (#44)", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
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
      "/x/config.json",
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
      "/x/config.json",
      deps({
        loadConfigFn: () =>
          ({ ...okConfig, healthEnabled: true, healthHost: "127.0.0.1" }) as unknown as Config,
        printFn: (s) => lines.push(s),
      }),
    );
    expect(lines.join("")).not.toMatch(/health bind/);
  });
});

describe("runDoctor split queue check (7-bis, #274)", () => {
  // okConfig.queueRoot ("/sbxroot/junco-doc-vault") matches neither derivable
  // knownQueueRoots shape, so it always comes back labeled "configured",
  // resolved: true — the canonical root below (env.HOME-derived) is the one
  // "other" root in play for these fixtures.
  const resolvedInbox = join(okConfig.queueRoot, "inbox");
  const canonicalInbox = join("/sbxroot/home", ".junco", "queue", "inbox");

  it("reports a warn naming both roots when the resolved queue is empty but another known root holds tickets", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        env: { HOME: "/sbxroot/home" },
        // Resolved inbox stays absent (existsFn false); the canonical root's
        // inbox exists and lists one ticket.
        existsFn: (p: string) => p === canonicalInbox || p.endsWith("/skills"),
        readdirFn: (d: string) => (d === canonicalInbox ? ["a.md"] : []),
        printFn: (s) => lines.push(s),
      }),
    );
    const out = lines.join("");
    expect(code).toBe(0); // warn-only: a split queue never moves the exit code
    expect(out).toMatch(/⚠ queue roots/);
    expect(out).toContain(resolvedInbox);
    expect(out).toContain("/sbxroot/home/.junco/queue");
  });

  it("reports pass when only the resolved root holds tickets (no split)", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        env: { HOME: "/sbxroot/home" },
        existsFn: (p: string) => p === resolvedInbox || p.endsWith("/skills"),
        readdirFn: (d: string) => (d === resolvedInbox ? ["a.md"] : []),
        printFn: (s) => lines.push(s),
      }),
    );
    const out = lines.join("");
    expect(code).toBe(0);
    expect(out).toMatch(/✓ queue roots/);
    expect(out).not.toMatch(/⚠ queue roots/);
  });

  it("a detector throw is reported as a warn, not a crash, and does not move the exit code", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        env: { HOME: "/sbxroot/home" },
        // Only the inbox-path probes throw — every other check's existsFn
        // call (deprecated-key/pending-migration probes, skill links, etc.)
        // must keep behaving normally so this test isolates the split-queue
        // check's own throw handling instead of tripping an unrelated one.
        existsFn: (p: string) => {
          if (p.endsWith("/inbox")) throw new Error("boom");
          return p.endsWith("/skills");
        },
        printFn: (s) => lines.push(s),
      }),
    );
    const out = lines.join("");
    expect(code).toBe(0);
    expect(out).toMatch(/⚠ queue roots/);
    expect(out).toMatch(/boom/);
  });
});

describe("runDoctor — deprecations + pending migrations (Unified Data Root spec §5, §7)", () => {
  it("legacy-keyed cfg reports a 'deprecated config keys' warning listing vaultRoot", async () => {
    const lines: string[] = [];
    const cfg = {
      ...okConfig,
      legacy: { ...okConfig.legacy, vaultRoot: true },
    } as unknown as Config;
    const code = await runDoctor(
      "/x/config.json",
      deps({ loadConfigFn: () => cfg, printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(0); // warn-level only — never fails doctor
    expect(lines.join("")).toMatch(/⚠ deprecated config keys.*vaultRoot/);
  });

  it("a fake existsFn making <dataDir>/assess-review exist reports 'unmigrated data dirs' with the migrate hint", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => okConfig,
        existsFn: (p: string) => p === join(okConfig.dataDir, "assess-review"),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0); // warn-level only — never fails doctor
    expect(lines.join("")).toMatch(/⚠ unmigrated data dirs/);
    expect(lines.join("")).toContain(join(okConfig.dataDir, "assess-review"));
    expect(lines.join("")).toContain("junco data migrate");
  });

  it("clean cfg reports neither deprecations nor unmigrated dirs", async () => {
    const lines: string[] = [];
    // #199.3: existsFn/readdirFn injected so "clean" is hermetic, not reliant
    // on the host filesystem not containing the /tmp/junco-doc-* literals.
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => okConfig,
        existsFn: () => false,
        readdirFn: () => [],
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).not.toMatch(/deprecated config keys/);
    expect(lines.join("")).not.toMatch(/unmigrated data dirs/);
  });

  it("a legacy dataRoot config's 'unmigrated data dirs' warning also lists the pending single-root layout move (2026-08-03 plan)", async () => {
    const lines: string[] = [];
    const legacyRoot = "/sbxroot/legacy-data-root";
    const cfg = {
      ...okConfig,
      dataDir: legacyRoot,
      legacy: { ...okConfig.legacy, dataRoot: true },
    } as unknown as Config;
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => cfg,
        existsFn: (p: string) => p === join(legacyRoot, "outbox"),
        env: { HOME: "/sbxroot/home" },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0); // warn-level only — never fails doctor
    const text = lines.join("");
    expect(text).toMatch(/⚠ unmigrated data dirs/);
    expect(text).toContain(join(legacyRoot, "outbox"));
    expect(text).toContain(join("/sbxroot/home", ".junco", "data", "outbox"));
    expect(text).toContain("junco data migrate");
  });

  // Reopened case (a) — task-6 review: an explicit, NON-legacy dataDir with
  // real flat-shaped content on disk has a genuinely pending in-place v2
  // restructure too — pendingMigrations' layout-pair reporting has no
  // legacy.dataRoot gate, so doctor must surface this WITHOUT the legacy
  // fallback ever being in play.
  it("an explicit non-legacy flat dataDir also surfaces its own pending in-place restructure (no legacy.dataRoot needed)", async () => {
    const lines: string[] = [];
    const root = "/sbxroot/explicit-flat-root";
    const cfg = { ...okConfig, dataDir: root } as unknown as Config; // legacy.dataRoot stays false
    expect(cfg.legacy.dataRoot).toBe(false);
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => cfg,
        existsFn: (p: string) => p === join(root, "outbox"),
        env: { HOME: "/sbxroot/home" },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    const text = lines.join("");
    expect(text).toMatch(/⚠ unmigrated data dirs/);
    expect(text).toContain(join(root, "outbox"));
    expect(text).toContain(join(root, "data", "outbox"));
    expect(text).toContain("junco data migrate");
  });

  it("legacy worktreeRoot dir with leftovers → info-level (✓) hint, itself not a warning", async () => {
    const lines: string[] = [];
    // legacy.worktreeRoot:true also trips the "deprecated config keys" WARN
    // above (git.worktreeRoot is one of the four checked keys) — this test
    // pins that the worktree-leftover hint ITSELF reports ok (✓), not warn,
    // distinguishing "here's where the old stuff is" from "please fix this".
    const cfg = {
      ...okConfig,
      legacy: { ...okConfig.legacy, worktreeRoot: true },
    } as unknown as Config;
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => cfg,
        // "/skills" carve-out keeps the 2d skill-links check silent (ok) so
        // it doesn't add a second warning here — see the shared deps() default.
        existsFn: (p: string) => p === okConfig.worktreeRoot || p.endsWith("/skills"),
        readdirFn: (d: string) => (d === okConfig.worktreeRoot ? ["some-ticket-wt"] : []),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/✓ legacy worktree root/);
    expect(lines.join("")).toContain(okConfig.worktreeRoot);
    // While git.worktreeRoot is SET it is the ACTIVE root (the override wins)
    // — the hint must say so, and must NOT claim the worktrees there are
    // already disposable or that new worktrees go under <dataDir>/worktrees.
    expect(lines.join("")).toMatch(/currently live at/);
    expect(lines.join("")).toMatch(/after removing the key/);
    expect(lines.join("")).not.toMatch(/safe to delete/);
    // Exactly one warning: the co-occurring deprecated-key finding, not this hint.
    expect(lines.join("")).toMatch(/1 warning\(s\)/);
  });

  it("legacy worktreeRoot dir present but EMPTY → no hint at all", async () => {
    const lines: string[] = [];
    const cfg = {
      ...okConfig,
      legacy: { ...okConfig.legacy, worktreeRoot: true },
    } as unknown as Config;
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => cfg,
        existsFn: (p: string) => p === okConfig.worktreeRoot,
        readdirFn: () => [],
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).not.toMatch(/legacy worktree root/);
  });

  it("worktreeRoot is NOT legacy → no hint even if the dir happens to exist and hold entries", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => okConfig,
        existsFn: (p: string) => p === okConfig.worktreeRoot,
        readdirFn: (d: string) => (d === okConfig.worktreeRoot ? ["leftover"] : []),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).not.toMatch(/legacy worktree root/);
  });
});

describe("runDoctor skill links check (2d, spec 2026-08-19)", () => {
  const skillsMount = join(okConfig.dataDir, "skills");

  /** okConfig with the given harness dirs consented to. */
  const withHarnessDirs = (harnessDirs: string[]): Config =>
    ({ ...okConfig, skills: { harnessDirs } }) as unknown as Config;

  it("reports ok skill links when the mount and every configured harness link resolve", async () => {
    const lines: string[] = [];
    const harnessDir = "/sbxroot/home/.claude/skills";
    const harnessLink = join(harnessDir, SKILL_DIR_NAME);
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => withHarnessDirs([harnessDir]),
        existsFn: (p: string) =>
          p === skillsMount || p === "/sbxroot/home/.claude" || p === harnessLink,
        // Both checked link paths (mount + harness link) are healthy
        // symlinks here — the default lstatFn fixture only vouches for the
        // "/skills"-suffixed mount, so the harness link needs its own.
        lstatFn: () => ({ isSymbolicLink: () => true }),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/✓ skill links/);
  });

  it("warns on a dead skill link and points at 'junco skill install'", async () => {
    const lines: string[] = [];
    const harnessDir = "/sbxroot/home/.claude/skills";
    const harnessLink = join(harnessDir, SKILL_DIR_NAME);
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => withHarnessDirs([harnessDir]),
        // Mount and harness parent both resolve — only the harness's
        // junco-dispatch link itself is dead.
        existsFn: (p: string) => p === skillsMount || p === "/sbxroot/home/.claude",
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0); // warn-level only — never fails doctor
    const text = lines.join("");
    expect(text).toMatch(/⚠ skill links/);
    expect(text).toContain(harnessLink);
    expect(text).toMatch(/junco skill install/);
  });

  it("skips a harness dir whose parent doesn't exist (not installed here) — still ok when the mount is healthy", async () => {
    const lines: string[] = [];
    const harnessDir = "/sbxroot/home/.claude/skills"; // parent /sbxroot/home/.claude is absent
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => withHarnessDirs([harnessDir]),
        existsFn: (p: string) => p === skillsMount, // only the mount resolves
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    const text = lines.join("");
    expect(text).toMatch(/✓ skill links/);
    expect(text).not.toContain(harnessDir);
  });

  // A real file/directory squatting on a link path is the one state
  // ensureSkillLinks (skillLinks.ts) refuses to self-heal ("occupied by a
  // non-symlink — not touching it") — probing with existsFn alone can't tell
  // this apart from a healthy symlink (both resolve), so doctor needs lstat
  // to distinguish "blocked" from "ok".
  it("warns 'blocked' (not ok) when a real dir squats on the skills mount path", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => okConfig,
        existsFn: (p: string) => p === skillsMount, // resolves — it's a real dir, not dead
        lstatFn: (p: string) =>
          p === skillsMount
            ? { isSymbolicLink: () => false }
            : (() => {
                throw new Error("ENOENT");
              })(),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0); // warn-level only — never fails doctor
    const text = lines.join("");
    expect(text).toMatch(/⚠ skill links blocked/);
    expect(text).toContain(skillsMount);
    expect(text).toMatch(/non-symlink|not a symlink/);
  });

  it("warns 'blocked' (not ok) when a real file/dir squats on a harness skill-link path", async () => {
    const lines: string[] = [];
    const harnessDir = "/sbxroot/home/.claude/skills";
    const harnessLink = join(harnessDir, SKILL_DIR_NAME);
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => withHarnessDirs([harnessDir]),
        existsFn: (p: string) =>
          p === skillsMount || p === "/sbxroot/home/.claude" || p === harnessLink,
        lstatFn: (p: string) =>
          p === harnessLink
            ? { isSymbolicLink: () => false }
            : p === skillsMount
              ? { isSymbolicLink: () => true }
              : (() => {
                  throw new Error("ENOENT");
                })(),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    const text = lines.join("");
    expect(text).toMatch(/⚠ skill links blocked/);
    expect(text).toContain(harnessLink);
    expect(text).toMatch(/non-symlink|not a symlink/);
  });
});

describe("runDoctor hosted-aware preflight", () => {
  /** A hosted config with an apiKey set (auth-check tests need a real key to
   * send, unlike the resolution/skip tests above). */
  function hostedCfg(over: { model?: Partial<ReturnType<typeof hostedModel>> } = {}): Config {
    return {
      ...okConfig,
      model: { ...hostedModel(), apiKey: "sk-ant-test", ...over.model },
    } as unknown as Config;
  }

  it("a cascade throw on resolution → fail with the error text", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => hostedCfg(),
        resolveInfoFn: async () => {
          throw new Error("no catalog match for anthropic/claude-x");
        },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/✗ model — no catalog match for anthropic\/claude-x/);
  });

  it("key source: config literal", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => hostedCfg(),
        resolveInfoFn: async () => catalogInfo(),
        rawApiKeyFn: () => "sk-ant-literal",
        fetchFn: async () => ({ ok: true, status: 200 }) as Response,
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/✓ key source — config literal \(model\.apiKey\)/);
  });

  it("key source: $VAR reference resolves", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => hostedCfg(),
        resolveInfoFn: async () => catalogInfo(),
        rawApiKeyFn: () => "$MY_ANTHROPIC_KEY",
        fetchFn: async () => ({ ok: true, status: 200 }) as Response,
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(
      /✓ key source — \$MY_ANTHROPIC_KEY \(resolved from the environment\)/,
    );
  });

  it("key source: provider env var name present (apiKey unset in config)", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => hostedCfg({ model: { ...hostedModel(), apiKey: null } }),
        resolveInfoFn: async () => catalogInfo(),
        rawApiKeyFn: () => undefined,
        env: { ANTHROPIC_API_KEY: "present-in-env" },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/✓ key source — ANTHROPIC_API_KEY present in the environment/);
    // apiKey is null → the auth check has nothing to send, so it notes that
    // instead of silently skipping.
    expect(lines.join("")).toMatch(/⚠ auth — no key configured/);
  });

  it("key source: none — warns for a non-local provider with the generic env-var name", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => hostedCfg({ model: { ...hostedModel(), apiKey: null } }),
        resolveInfoFn: async () => catalogInfo(),
        rawApiKeyFn: () => undefined,
        env: {},
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(
      /⚠ key source — no key configured — the SDK will typically look for ANTHROPIC_API_KEY-style env vars at request time/,
    );
  });

  it("auth check: 200 → ok, and sends the anthropic-messages free route correctly", async () => {
    const lines: string[] = [];
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => hostedCfg(),
        resolveInfoFn: async () => catalogInfo(),
        rawApiKeyFn: () => "sk-ant-literal",
        fetchFn,
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/✓ auth — auth verified/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
  });

  it("auth check: sends the openai-completions free route correctly", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => hostedCfg(),
        resolveInfoFn: async () =>
          catalogInfo({
            provider: "openai",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
          }),
        rawApiKeyFn: () => "sk-oai-literal",
        fetchFn,
      }),
    );
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-ant-test");
  });

  it("auth check: sends the google free route correctly (key as a query param)", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => hostedCfg(),
        resolveInfoFn: async () =>
          catalogInfo({
            provider: "google",
            api: "google-generative-ai",
            // The real vendored catalog baseUrl (pi-ai providers/google.models.js)
            // already ends with /v1beta — pinning the real convention here is
            // the regression proof: the old code appended /v1beta unconditionally
            // and would have built .../v1beta/v1beta/models (permanent 404).
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          }),
        rawApiKeyFn: () => "sk-goog-literal",
        fetchFn,
      }),
    );
    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models?key=sk-ant-test");
  });

  it("auth check: 401 → fail (auth rejected)", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => hostedCfg(),
        resolveInfoFn: async () => catalogInfo(),
        rawApiKeyFn: () => "sk-ant-literal",
        fetchFn: async () => ({ ok: false, status: 401 }) as Response,
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/✗ auth — auth rejected \(check the key\)/);
  });

  it("auth check: 403 → fail (auth rejected)", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => hostedCfg(),
        resolveInfoFn: async () => catalogInfo(),
        rawApiKeyFn: () => "sk-ant-literal",
        fetchFn: async () => ({ ok: false, status: 403 }) as Response,
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/✗ auth — auth rejected \(check the key\)/);
  });

  it("auth check: network error → warn (endpoint unreachable), does not fail doctor", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => hostedCfg(),
        resolveInfoFn: async () => catalogInfo(),
        rawApiKeyFn: () => "sk-ant-literal",
        fetchFn: async () => {
          throw new Error("ECONNREFUSED");
        },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ auth — endpoint unreachable/);
  });

  it("auth check: unknown api family → skip with a note, no request sent", async () => {
    const lines: string[] = [];
    const fetchFn = vi.fn();
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => hostedCfg(),
        resolveInfoFn: async () => catalogInfo({ api: "mistral-conversations" }),
        rawApiKeyFn: () => "sk-ant-literal",
        fetchFn,
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(
      /✓ auth — unknown api "mistral-conversations" — auth check skipped/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("auth check: skipped (not a fail) when the resolved path falls through to inline, not catalog", async () => {
    const lines: string[] = [];
    const fetchFn = vi.fn();
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => hostedCfg(),
        resolveInfoFn: async () => catalogInfo({ path: "inline" }),
        rawApiKeyFn: () => "sk-ant-literal",
        fetchFn,
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).not.toMatch(/auth —/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("planner preflight: no plannerModelId configured → no planner line at all", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => okConfig,
        resolveInfoFn: async () => catalogInfo(),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).not.toMatch(/planner model/);
  });

  it("planner preflight: plannerModelId set → resolves ok, alongside an ordinary local primary model", async () => {
    const lines: string[] = [];
    const cfg = {
      ...okConfig,
      github: { ...okConfig.github, plannerModelId: "openai/gpt-4o" },
    } as unknown as Config;
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => cfg,
        resolveInfoFn: async (_c: Config, modelId?: string) =>
          catalogInfo({ provider: "openai", modelId, api: "openai-completions" }),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/✓ planner model — openai\/gpt-4o resolves via catalog/);
  });

  it("planner preflight: a miss warns (not fails) — ordinary tickets don't use it", async () => {
    const lines: string[] = [];
    const cfg = {
      ...okConfig,
      github: { ...okConfig.github, plannerModelId: "openai/does-not-exist" },
    } as unknown as Config;
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => cfg,
        resolveInfoFn: async (_c: Config, modelId?: string) => {
          if (modelId === undefined) return catalogInfo();
          throw new Error("no catalog match for openai/does-not-exist");
        },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ planner model — no catalog match for openai\/does-not-exist/);
  });

  it("default config: a clean report — no optional-feature lines leak in (regression)", async () => {
    // One doctor run over the default okConfig. Every default-OFF feature must
    // stay silent; asserting all absences here against a single output is
    // exactly equivalent to (and replaces) the seven scattered one-absence
    // tests that each re-ran the whole doctor. Each feature's PRESENCE behavior
    // is still tested in its own describe.
    const lines: string[] = [];
    const code = await runDoctor("/x/config.json", deps({ printFn: (s) => lines.push(s) }));
    expect(code).toBe(0);
    const out = lines.join("");
    // hosted-preflight lines
    expect(out).not.toMatch(/resolves via/);
    expect(out).not.toMatch(/key source/);
    expect(out).not.toMatch(/planner model/);
    expect(out).not.toMatch(/✓ auth —|✗ auth —|⚠ auth —/);
    // default-off features (formerly one full doctor run each)
    expect(out).not.toMatch(/sandbox/i);
    expect(out).not.toMatch(/github/);
    expect(out).not.toMatch(/bot account/i);
    expect(out).not.toMatch(/outbox/);
    expect(out).not.toMatch(/assess review/);
    expect(out).not.toMatch(/analyze drafts/);
    expect(out).not.toMatch(/assess history/);
    expect(out).toMatch(/ready — 0 failure\(s\), 0 warning\(s\)/);
  });
});

describe("runDoctor github checks", () => {
  it("warns when enabled with no repos", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({ loadConfigFn: () => githubConfig([]), printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ github — enabled but no repos configured/);
  });

  it("fails a repo whose origin does not match the nwo", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
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
      "/x/config.json",
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
      "/x/config.json",
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
      "/x/config.json",
      deps({ loadConfigFn: () => githubConfig([]), printFn: (s) => lines.push(s) }),
    );
    expect(lines.join("")).toMatch(/✓ github planner template/);
  });

  it("fails a repo not reachable via gh", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
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
    writeWatchlist(join(stateDir, WATCHLIST_FILENAME), [{ nwo: "alx/coral", path: "/tmp/coral" }]);
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => ({ ...githubConfig([]), dataDir: stateDir }) as Config,
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

describe("runDoctor bot account checks", () => {
  it("bot mode: reports identity when the bot login differs from the ambient login", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => botConfig(),
        execFn: async (_cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
          const key = args.join(" ");
          if (key === "api user" && opts?.env?.GH_CONFIG_DIR === "/sbx/junco-gh") {
            return { code: 0, stdout: JSON.stringify({ login: "junco-agent" }), stderr: "" };
          }
          if (key === "api user") {
            return { code: 0, stdout: JSON.stringify({ login: "human" }), stderr: "" };
          }
          return { code: 0, stdout: "ok", stderr: "" };
        },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/✓ bot account — acting as junco-agent/);
  });

  it("bot mode: warns when the bot login equals the ambient login", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => botConfig(),
        // Both the bot-env call and the ambient call resolve to the same
        // login here — simulates a bot account that is really just the
        // operator's own gh login, which defeats the point of a separate
        // identity.
        execFn: async (_cmd: string, args: string[]) => {
          const key = args.join(" ");
          if (key === "api user") {
            return { code: 0, stdout: JSON.stringify({ login: "human" }), stderr: "" };
          }
          return { code: 0, stdout: "ok", stderr: "" };
        },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ bot account.*equals your personal gh login/);
  });

  it("bot mode: fails the bot-account check when not logged in", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => botConfig(),
        execFn: async (_cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
          const key = args.join(" ");
          if (key === "api user" && opts?.env?.GH_CONFIG_DIR === "/sbx/junco-gh") {
            return { code: 1, stdout: "", stderr: "not logged in" };
          }
          return { code: 0, stdout: "ok", stderr: "" };
        },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/✗ bot account.*not logged in under \/sbx\/junco-gh/);
    expect(lines.join("")).toMatch(/junco auth login/);
  });

  it("SAML-blocked bot probe → SSO guidance", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => botConfig(),
        execFn: async (_cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
          const key = args.join(" ");
          if (key === "api user" && opts?.env?.GH_CONFIG_DIR === "/sbx/junco-gh") {
            return {
              code: 1,
              stdout: "",
              stderr: "HTTP 403: Resource protected by organization SAML enforcement",
            };
          }
          return { code: 0, stdout: "ok", stderr: "" };
        },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/✗ bot account.*authorize gh for the org/);
  });

  it("bot mode: skips the bot-account check entirely when gh itself is not installed", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => botConfig(),
        execFn: async (cmd: string, args: string[]) =>
          cmd === "gh" && args[0] === "--version"
            ? { code: 127, stdout: "", stderr: "not found" }
            : { code: 0, stdout: "ok", stderr: "" },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).not.toMatch(/bot account/i);
  });

  it("bot mode: reports ok bot access for a watched repo with write permission", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () =>
          botConfig({
            github: {
              ...okConfig.github,
              enabled: true,
              repos: [{ nwo: "acme/api", path: "/tmp/clone" }],
            },
          }),
        execFn: async (_cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
          if (args.includes("get-url")) {
            return { code: 0, stdout: "git@github.com:acme/api.git\n", stderr: "" };
          }
          if (args[0] === "repo" && args[1] === "view" && args.includes("viewerPermission")) {
            // WRITE only under the bot's GH_CONFIG_DIR AND with GH_TOKEN/
            // GITHUB_TOKEN cleared — ambient auth or an un-cleared token would
            // read code 1 → "unknown" warn, flipping the ✓ assertion below. Pins
            // both the identity dir and the #186 token-clearing (#192.3).
            return opts?.env?.GH_CONFIG_DIR === "/sbx/junco-gh" &&
              opts?.env?.GH_TOKEN === "" &&
              opts?.env?.GITHUB_TOKEN === ""
              ? { code: 0, stdout: JSON.stringify({ viewerPermission: "WRITE" }), stderr: "" }
              : { code: 1, stdout: "", stderr: "wrong identity" };
          }
          return { code: 0, stdout: "ok", stderr: "" };
        },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/✓ bot access: acme\/api — write/);
  });

  it("bot mode: warns with the grant command on TRIAGE permission for a watched repo", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () =>
          botConfig({
            github: {
              ...okConfig.github,
              enabled: true,
              repos: [{ nwo: "acme/api", path: "/tmp/clone" }],
            },
          }),
        execFn: async (_cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
          if (args.includes("get-url")) {
            return { code: 0, stdout: "git@github.com:acme/api.git\n", stderr: "" };
          }
          if (args[0] === "repo" && args[1] === "view" && args.includes("viewerPermission")) {
            // TRIAGE only under the bot's GH_CONFIG_DIR — ambient auth reads
            // WRITE (→ ok), which would flip the ⚠ triage assertion below.
            return opts?.env?.GH_CONFIG_DIR === "/sbx/junco-gh"
              ? { code: 0, stdout: JSON.stringify({ viewerPermission: "TRIAGE" }), stderr: "" }
              : { code: 0, stdout: JSON.stringify({ viewerPermission: "WRITE" }), stderr: "" };
          }
          return { code: 0, stdout: "ok", stderr: "" };
        },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(
      /⚠ bot access: acme\/api — triage — label edits work, branch pushes will fail — fix: junco auth grant acme\/api/,
    );
  });

  it("bot mode: warns with the grant command on NONE permission for a watched repo", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () =>
          botConfig({
            github: {
              ...okConfig.github,
              enabled: true,
              repos: [{ nwo: "acme/api", path: "/tmp/clone" }],
            },
          }),
        execFn: async (_cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
          if (args.includes("get-url")) {
            return { code: 0, stdout: "git@github.com:acme/api.git\n", stderr: "" };
          }
          if (args[0] === "repo" && args[1] === "view" && args.includes("viewerPermission")) {
            // NONE only under the bot's GH_CONFIG_DIR — ambient auth reads
            // WRITE (→ ok), which would flip the ⚠ NONE assertion below.
            return opts?.env?.GH_CONFIG_DIR === "/sbx/junco-gh"
              ? { code: 0, stdout: JSON.stringify({ viewerPermission: "NONE" }), stderr: "" }
              : { code: 0, stdout: JSON.stringify({ viewerPermission: "WRITE" }), stderr: "" };
          }
          return { code: 0, stdout: "ok", stderr: "" };
        },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(
      /⚠ bot access: acme\/api — NONE — fix: junco auth grant acme\/api/,
    );
  });

  it("bot mode: SAML-blocked per-repo permission probe → SSO guidance", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () =>
          botConfig({
            github: {
              ...okConfig.github,
              enabled: true,
              repos: [{ nwo: "acme/api", path: "/tmp/clone" }],
            },
          }),
        execFn: async (_cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
          if (args.includes("get-url")) {
            return { code: 0, stdout: "git@github.com:acme/api.git\n", stderr: "" };
          }
          if (args[0] === "repo" && args[1] === "view" && args.includes("viewerPermission")) {
            return opts?.env?.GH_CONFIG_DIR === "/sbx/junco-gh"
              ? {
                  code: 1,
                  stdout: "",
                  stderr: "HTTP 403: Resource protected by organization SAML enforcement",
                }
              : { code: 0, stdout: JSON.stringify({ viewerPermission: "WRITE" }), stderr: "" };
          }
          return { code: 0, stdout: "ok", stderr: "" };
        },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ bot access: acme\/api.*authorize gh for the org/);
  });

  it("non-bot mode: does not check per-repo bot permission at all", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
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
    expect(lines.join("")).not.toMatch(/bot access/i);
  });

  // #189: an SSH origin under bot mode warns (pushes bypass the bot cred
  // helper); an https origin does not.
  it("bot mode: warns on an SSH origin, stays quiet on an https origin", async () => {
    const run = async (originUrl: string) => {
      const lines: string[] = [];
      await runDoctor(
        "/x/config.json",
        deps({
          loadConfigFn: () =>
            botConfig({
              github: {
                ...okConfig.github,
                enabled: true,
                repos: [{ nwo: "acme/api", path: "/tmp/clone" }],
              },
            }),
          execFn: async (_cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
            if (args.includes("get-url")) return { code: 0, stdout: originUrl + "\n", stderr: "" };
            if (args[0] === "repo" && args[1] === "view" && args.includes("viewerPermission")) {
              return opts?.env?.GH_CONFIG_DIR === "/sbx/junco-gh"
                ? { code: 0, stdout: JSON.stringify({ viewerPermission: "WRITE" }), stderr: "" }
                : { code: 1, stdout: "", stderr: "wrong identity" };
            }
            return { code: 0, stdout: "ok", stderr: "" };
          },
          printFn: (s) => lines.push(s),
        }),
      );
      return lines.join("");
    };
    expect(await run("git@github.com:acme/api.git")).toMatch(
      /⚠ bot remote: acme\/api.*not an https/,
    );
    expect(await run("https://github.com/acme/api.git")).not.toMatch(/bot remote:/);
  });
});

describe("runDoctor outbox checks", () => {
  it("warns on a queued backlog (does not fail doctor)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-doc-obx-"));
    const { dir } = outboxPaths({ dataDir: stateDir } as unknown as Config);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1-a-labels.json"), "{}", "utf8");
    writeFileSync(join(dir, "2-b-labels.json"), "{}", "utf8");
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => ({ ...okConfig, dataDir: stateDir }),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ outbox backlog — 2 queued \(junco outbox flush\)/);
  });

  it("warns on dead-letters, mentioning the dead/ dir (does not fail doctor)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-doc-obxdead-"));
    const { dead } = outboxPaths({ dataDir: stateDir } as unknown as Config);
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "1-a-labels.json"), "{}", "utf8");
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => ({ ...okConfig, dataDir: stateDir }),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ outbox dead-letters/);
    expect(lines.join("")).toContain(dead);
  });
});

describe("runDoctor assess review checks", () => {
  it("reports pending reviews as informational — not a warning, github disabled", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-doc-review-"));
    writePending({ dataDir: stateDir } as unknown as Config, {
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
      "/x/config.json",
      deps({
        loadConfigFn: () => ({ ...okConfig, dataDir: stateDir }),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    // okConfig has github.enabled = false — the review count must still surface.
    expect(lines.join("")).toMatch(/✓ assess review — 1 pending \(junco assess review\)/);
    expect(lines.join("")).toMatch(/0 warning\(s\)/);
  });
});

describe("runDoctor analyze review checks", () => {
  it("reports pending drafts as informational — not a warning, github disabled", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-doc-draft-"));
    writeDraft({ dataDir: stateDir } as unknown as Config, {
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
      "/x/config.json",
      deps({
        loadConfigFn: () => ({ ...okConfig, dataDir: stateDir }),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    // okConfig has github.enabled = false — the draft count must still surface.
    expect(lines.join("")).toMatch(/✓ analyze drafts — 1 pending \(junco analyze review\)/);
    expect(lines.join("")).toMatch(/0 warning\(s\)/);
  });
});

describe("runDoctor assess history checks", () => {
  it("reports per-repo assess history informationally — never as a warning", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "junco-doc-history-"));
    recordRun({ dataDir } as unknown as Config, "o/r", {
      ok: true,
      at: "2026-07-16T00:00:00.000Z",
      found: 4,
      parked: 3,
    });
    const lines: string[] = [];
    // existsFn: false except the skills mount — hermetic against
    // pendingMigrations' now-truthful real-fs probing (task-6 review): this
    // fixture's real dataDir genuinely has assess-history/ on disk (recordRun
    // wrote it), which is correct input for THAT check but irrelevant noise
    // for this one (#199.3 pattern — see "clean cfg reports neither..."
    // above). The "/skills" carve-out keeps the 2d skill-links check silent
    // (ok) too, same as the shared deps() default. listHistory itself reads
    // the real fs directly (no existsFn seam), so the assertion below is
    // unaffected.
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => ({ ...okConfig, dataDir }),
        existsFn: (p: string) => p.endsWith("/skills"),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/✓ assess history — o\/r: assessed 2026-07-16/);
    expect(lines.join("")).toMatch(/0 warning\(s\)/);
  });

  it("shows a failed last attempt as informational, not a warning — never assessed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "junco-doc-history-fail-"));
    recordRun({ dataDir } as unknown as Config, "o/other", {
      ok: false,
      at: "2026-07-16T00:00:00.000Z",
      reason: "boom",
    });
    const lines: string[] = [];
    // existsFn: false except the skills mount — see the hermeticity note in
    // the previous test.
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => ({ ...okConfig, dataDir }),
        existsFn: (p: string) => p.endsWith("/skills"),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(
      /✓ assess history — o\/other: never assessed \(last attempt failed\)/,
    );
    expect(lines.join("")).toMatch(/0 warning\(s\)/);
  });

  // #204: the combined branch — a repo that succeeded, then later failed —
  // shows BOTH the last-success date and the failed flag.
  it("a repo that succeeded then later failed shows both the date and the failed flag", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "junco-doc-history-both-"));
    recordRun({ dataDir } as unknown as Config, "o/r", {
      ok: true,
      at: "2026-07-14T00:00:00.000Z",
      found: 2,
      parked: 1,
    });
    recordRun({ dataDir } as unknown as Config, "o/r", {
      ok: false,
      at: "2026-07-16T00:00:00.000Z",
      reason: "boom",
    });
    const lines: string[] = [];
    // existsFn: false except the skills mount — see the hermeticity note above.
    const code = await runDoctor(
      "/x/config.json",
      deps({
        loadConfigFn: () => ({ ...okConfig, dataDir }),
        existsFn: (p: string) => p.endsWith("/skills"),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(
      /✓ assess history — o\/r: assessed 2026-07-14 \(last attempt failed\)/,
    );
    expect(lines.join("")).toMatch(/0 warning\(s\)/);
  });
});

describe("runDoctor version check", () => {
  it("doctor reports an available update as a warning", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        checkUpdateFn: async () => ({ current: "0.7.0", latest: "0.8.0", available: true }),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(lines.join("")).toContain(
      "⚠ junco version — v0.7.0 — v0.8.0 available (run: junco update)",
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/1 warning\(s\)/);
  });

  it("doctor reports latest as ok", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        checkUpdateFn: async () => ({ current: "0.7.0", latest: "0.7.0", available: false }),
        printFn: (s) => lines.push(s),
      }),
    );
    expect(lines.join("")).toContain("✓ junco version — v0.7.0 (latest)");
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/0 warning\(s\)/);
  });

  it("doctor reports a skipped check as ok", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
      deps({
        checkUpdateFn: async () => null,
        printFn: (s) => lines.push(s),
      }),
    );
    expect(lines.join("")).toMatch(
      /✓ junco version — v\S+ \(update check skipped — offline or disabled\)/,
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/0 warning\(s\)/);
  });
});
