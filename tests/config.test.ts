import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  queuePaths,
  resolveConfigPath,
  defaultUserConfigPath,
  juncoHome,
  homeOf,
  layoutOf,
  dataRootHasTree,
  legacyConfigPath,
  isLoopbackHost,
  resolveApiKey,
  assembleConfig,
  ConfigSchema,
  expandHome,
  configDeprecations,
} from "../src/config.js";

function writeJson(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "junco-cfg-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}
function writeRaw(basename: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "junco-cfg-"));
  const p = join(dir, basename);
  writeFileSync(p, body, "utf8");
  return p;
}

describe("loadConfig (JSON)", () => {
  it("parses a minimal config and fills defaults", () => {
    const cfg = loadConfig(writeJson({ vaultRoot: "/tmp/vault" }));
    expect(cfg.queueRoot).toBe(join("/tmp/vault", "Junco"));
    expect(cfg.model.id).toBe("local/my-model");
    expect(cfg.model.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(cfg.model.api).toBe("openai-completions");
    expect(cfg.defaultTimeoutMinutes).toBe(30);
    expect(cfg.tools).toContain("read");
    expect(cfg.commitLeftoversEnabled).toBe(false);
  });

  it("reads promoted first-class fields (tools, worker.commitLeftovers)", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/v",
        tools: ["read", "bash"],
        worker: { commitLeftovers: true, maxConcurrent: 3 },
      }),
    );
    expect(cfg.tools).toEqual(["read", "bash"]);
    expect(cfg.commitLeftoversEnabled).toBe(true);
    expect(cfg.maxConcurrent).toBe(3);
  });

  it("reads camelCase model + observability fields", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/v",
        model: { id: "p/m", baseUrl: "http://h:9/v1", apiKey: "k", contextWindow: 4096 },
        observability: { healthPort: 9999, logLevel: "debug" },
      }),
    );
    expect(cfg.model.id).toBe("p/m");
    expect(cfg.model.contextWindow).toBe(4096);
    expect(cfg.healthPort).toBe(9999);
    expect(cfg.logLevel).toBe("debug");
  });

  it("merges model.compat onto DEFAULT_COMPAT (camelCase keys, no camelization)", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/v",
        model: { compat: { supportsDeveloperRole: true, customKey: 1 } },
      }),
    );
    expect(cfg.model.compat.supportsDeveloperRole).toBe(true);
    expect((cfg.model.compat as Record<string, unknown>).customKey).toBe(1);
    expect(cfg.model.compat.maxTokensField).toBe("max_tokens"); // default preserved
  });

  it("expands ~ in path fields and derives github cross-field defaults", () => {
    // existsFn: () => false — hermetic. "/state" is an explicit-but-fresh
    // root; without this the test runs against real existsSync, and the
    // expected value depends on whether the machine running the suite
    // happens to have a "/state" directory (same class of hazard
    // tests/doctor.test.ts's synthetic-path convention (#199.3) exists to
    // avoid — a real /tmp/junco-state hit this exact assertion in review).
    const cfg = assembleConfig(
      ConfigSchema.parse({
        vaultRoot: "~/LegacyVault",
        observability: { stateDir: "/state" },
        github: { enabled: true, triggerLabel: "bot" },
      }),
      {},
      { existsFn: () => false },
    );
    expect(cfg.queueRoot).not.toContain("~");
    expect(cfg.github.askLabel).toBe("bot:ask");
    // "/state" is a fresh (never-created) root — the layout flip defaults it
    // to v2 (cache/clones/external), same as any never-before-seen dataDir.
    expect(cfg.github.externalReposRoot).toBe("/state/cache/clones/external");
    expect(cfg.github.plannerModelId).toBeNull();
  });

  it("vaultRoot is optional — a config with no keys at all parses (unified data root)", () => {
    expect(() => loadConfig(writeJson({ model: { id: "x" } }))).not.toThrow();
  });

  it("throws a friendly error on malformed JSON", () => {
    const p = writeRaw("config.json", "{ not json");
    expect(() => loadConfig(p)).toThrow(/not valid JSON/);
  });

  it("guards a leftover config.toml where config.json is expected", () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-cfg-"));
    writeFileSync(join(dir, "config.toml"), 'vault_root = "/v"\n', "utf8");
    expect(() => loadConfig(join(dir, "config.json"))).toThrow(/TOML config was removed/);
  });

  it("[model] defaults reproduce the previously-hardcoded values", () => {
    const cfg = loadConfig(writeJson({ vaultRoot: "/tmp/vault" }));
    expect(cfg.model.id).toBe("local/my-model");
    expect(cfg.model.modelsJson).toBeNull();
    expect(cfg.model.api).toBe("openai-completions");
    expect(cfg.model.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(cfg.model.reasoning).toBe(true);
    expect(cfg.model.input).toEqual(["text", "image"]);
    expect(cfg.model.contextWindow).toBe(131072);
    expect(cfg.model.maxTokens).toBe(49152);
    expect(cfg.model.thinkingLevel).toBe("medium");
    expect(cfg.model.compat.maxTokensField).toBe("max_tokens");
    expect(cfg.model.compat.thinkingFormat).toBe("qwen-chat-template");
  });

  it("[model] fields override the defaults; compat keys pass through verbatim", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/tmp/vault",
        model: {
          id: "anthropic/claude",
          api: "anthropic-messages",
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-x",
          contextWindow: 200000,
          maxTokens: 8192,
          reasoning: false,
          thinkingLevel: "high",
          modelsJson: "~/models.json",
          compat: { thinkingFormat: "anthropic", maxTokensField: "max_completion_tokens" },
        },
      }),
    );
    expect(cfg.model.id).toBe("anthropic/claude");
    expect(cfg.model.api).toBe("anthropic-messages");
    expect(cfg.model.baseUrl).toBe("https://api.example.com/v1");
    expect(cfg.model.apiKey).toBe("sk-x");
    expect(cfg.model.contextWindow).toBe(200000);
    expect(cfg.model.maxTokens).toBe(8192);
    expect(cfg.model.reasoning).toBe(false);
    expect(cfg.model.thinkingLevel).toBe("high");
    expect(cfg.model.modelsJson).toBe(join(homedir(), "models.json"));
    expect(cfg.model.compat.thinkingFormat).toBe("anthropic");
    expect(cfg.model.compat.maxTokensField).toBe("max_completion_tokens");
    expect(cfg.model.compat.supportsUsageInStreaming).toBe(true);
  });

  it("expands a leading ~ in vaultRoot to the home dir", () => {
    const cfg = loadConfig(writeJson({ vaultRoot: "~/vault" }));
    expect(cfg.queueRoot).not.toContain("~");
    expect(cfg.queueRoot).toBe(join(homedir(), "vault", "Junco"));
  });

  it("applies supervisor defaults when supervisor is absent", () => {
    const cfg = loadConfig(writeJson({ vaultRoot: "/v" }));
    expect(cfg.supervisorEnabled).toBe(true);
    expect(cfg.supervisorBudgetPerKind).toBe(1);
    expect(cfg.supervisorEscalationWindow).toBe(3);
    expect(cfg.supervisorOutputBudgetPerTurn).toBe(12000);
    expect(cfg.supervisorOutputBudgetPostCommit).toBe(24000);
  });

  it("reads the supervisor knobs from config.json", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/v",
        supervisor: {
          enabled: false,
          budgetPerKind: 2,
          escalationWindowTurns: 5,
          outputBudgetPerTurn: 8000,
          outputBudgetPostCommit: 16000,
        },
      }),
    );
    expect(cfg.supervisorEnabled).toBe(false);
    expect(cfg.supervisorBudgetPerKind).toBe(2);
    expect(cfg.supervisorEscalationWindow).toBe(5);
    expect(cfg.supervisorOutputBudgetPerTurn).toBe(8000);
    expect(cfg.supervisorOutputBudgetPostCommit).toBe(16000);
  });

  it("applies critic defaults when critic is absent", () => {
    const cfg = loadConfig(writeJson({ vaultRoot: "/v" }));
    expect(cfg.criticEnabled).toBe(true);
    expect(cfg.criticMaxRetries).toBe(1);
    expect(cfg.criticThinking).toBe("minimal");
  });

  it("reads the critic knobs from config.json", () => {
    const cfg = loadConfig(
      writeJson({ vaultRoot: "/v", critic: { enabled: false, maxRetries: 2, thinking: "high" } }),
    );
    expect(cfg.criticEnabled).toBe(false);
    expect(cfg.criticMaxRetries).toBe(2);
    expect(cfg.criticThinking).toBe("high");
  });

  it("applies plan-lint + commitLeftovers defaults when sections are absent", () => {
    const cfg = loadConfig(writeJson({ vaultRoot: "/v" }));
    expect(cfg.planLintEnabled).toBe(true);
    expect(cfg.planLintBlockOnError).toBe(true);
    expect(cfg.planLintCheckLabels).toBe(true);
    expect(cfg.commitLeftoversEnabled).toBe(false);
  });

  it("reads the planLint knobs and worker.commitLeftovers from config.json", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/v",
        worker: { commitLeftovers: true },
        planLint: { enabled: false, blockOnError: false, checkLabels: false },
      }),
    );
    expect(cfg.planLintEnabled).toBe(false);
    expect(cfg.planLintBlockOnError).toBe(false);
    expect(cfg.planLintCheckLabels).toBe(false);
    expect(cfg.commitLeftoversEnabled).toBe(true);
  });

  it("applies observability defaults when the section is absent", () => {
    const cfg = loadConfig(writeJson({ vaultRoot: "/v" }));
    expect(cfg.healthEnabled).toBe(true);
    expect(cfg.healthHost).toBe("127.0.0.1");
    expect(cfg.healthPort).toBe(8787);
    expect(cfg.logLevel).toBe("info");
  });

  it("reads the observability knobs from config.json", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/v",
        observability: {
          healthEnabled: false,
          healthHost: "0.0.0.0",
          healthPort: 9999,
          logLevel: "warn",
        },
      }),
    );
    expect(cfg.healthEnabled).toBe(false);
    expect(cfg.healthHost).toBe("0.0.0.0");
    expect(cfg.healthPort).toBe(9999);
    expect(cfg.logLevel).toBe("warn");
  });

  it("normalizes an empty healthHost to loopback (#71)", () => {
    // "" passes zod's z.string() but server.listen(port, "") binds ALL
    // interfaces — the most-exposed config. Normalize it to loopback.
    const cfg = loadConfig(writeJson({ vaultRoot: "/v", observability: { healthHost: "" } }));
    expect(cfg.healthHost).toBe("127.0.0.1");
  });

  it("normalizes a whitespace-only healthHost to loopback (#71)", () => {
    const cfg = loadConfig(writeJson({ vaultRoot: "/v", observability: { healthHost: "   " } }));
    expect(cfg.healthHost).toBe("127.0.0.1");
  });

  it("keeps a real non-loopback healthHost verbatim (#71)", () => {
    const cfg = loadConfig(
      writeJson({ vaultRoot: "/v", observability: { healthHost: "0.0.0.0" } }),
    );
    expect(cfg.healthHost).toBe("0.0.0.0");
  });

  it("rejects an out-of-range observability.logLevel", () => {
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/v", observability: { logLevel: "verbose" } })),
    ).toThrow();
  });

  it("resilience + observability + concurrency defaults", () => {
    // existsFn: () => false — a fresh machine with neither ~/.junco nor the
    // legacy ~/.local/state/junco root, so dataDir defaults to ~/.junco.
    const cfg = assembleConfig(
      ConfigSchema.parse({ vaultRoot: "/v" }),
      {},
      { existsFn: () => false },
    );
    expect(cfg.maxTransientRetries).toBe(2);
    expect(cfg.retryBackoffSeconds).toBe(60);
    expect(cfg.maxConcurrent).toBe(1);
    expect(cfg.dataDir).toBe(join(homedir(), ".junco"));
    expect(cfg.logToFile).toBe(true);
    expect(cfg.transcriptsEnabled).toBe(true);
    expect(cfg.allowedRepoRoots).toEqual([]);
    // Phase-3 Task 5: off by default — the daemon never consults the spend
    // ledger unless the operator opts in.
    expect(cfg.dailyBudgetUsd).toBe(0);
  });

  it("updateCheck defaults true and honors an explicit false", () => {
    expect(loadConfig(writeJson({ vaultRoot: "/v" })).updateCheck).toBe(true);
    expect(loadConfig(writeJson({ vaultRoot: "/v", updateCheck: false })).updateCheck).toBe(false);
  });

  it("resilience keys are configurable", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/v",
        worker: {
          maxTransientRetries: 0,
          retryBackoffSeconds: 5,
          maxConcurrent: 3,
          dailyBudgetUsd: 3.5,
        },
        observability: { stateDir: "~/x", logToFile: false, transcripts: false },
        git: { allowedRepoRoots: ["~/code"] },
      }),
    );
    expect(cfg.maxTransientRetries).toBe(0);
    expect(cfg.retryBackoffSeconds).toBe(5);
    expect(cfg.maxConcurrent).toBe(3);
    expect(cfg.dataDir).toBe(join(homedir(), "x"));
    expect(cfg.logToFile).toBe(false);
    expect(cfg.transcriptsEnabled).toBe(false);
    expect(cfg.allowedRepoRoots).toEqual([join(homedir(), "code")]);
    expect(cfg.dailyBudgetUsd).toBe(3.5);
  });

  it("rejects maxConcurrent < 1 and negative retry knobs", () => {
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/v", worker: { maxConcurrent: 0 } })),
    ).toThrow();
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/v", worker: { maxTransientRetries: -1 } })),
    ).toThrow();
  });

  it("rejects a negative worker.dailyBudgetUsd", () => {
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/v", worker: { dailyBudgetUsd: -1 } })),
    ).toThrow();
  });

  it("rejects non-positive timeouts and poll intervals (#30)", () => {
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/v", worker: { defaultTimeoutMinutes: 0 } })),
    ).toThrow();
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/v", worker: { defaultTimeoutMinutes: -5 } })),
    ).toThrow();
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/v", worker: { pollIntervalSeconds: 0 } })),
    ).toThrow();
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/v", worker: { startupPollSeconds: -1 } })),
    ).toThrow();
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/v", verify: { commandTimeout: 0 } })),
    ).toThrow();
  });

  it("constrains healthPort to an integer TCP port (1-65535) (#30)", () => {
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/v", observability: { healthPort: 0 } })),
    ).toThrow();
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/v", observability: { healthPort: 65536 } })),
    ).toThrow();
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/v", observability: { healthPort: 8080.5 } })),
    ).toThrow();
    expect(
      loadConfig(writeJson({ vaultRoot: "/v", observability: { healthPort: 65535 } })).healthPort,
    ).toBe(65535);
  });
});

describe("dataDir default + legacy-root fallback (single-root ~/.junco)", () => {
  const env = { HOME: "/h" };

  it("defaults dataDir to ~/.junco with a v2 layout on a fresh machine", () => {
    const cfg = assembleConfig(ConfigSchema.parse({}), env, { existsFn: () => false });
    expect(cfg.dataDir).toBe("/h/.junco");
    expect(cfg.dataLayout).toBe("v2");
    expect(cfg.legacy.dataRoot).toBe(false);
    expect(cfg.queueRoot).toBe("/h/.junco/queue");
    expect(cfg.worktreeRoot).toBe("/h/.junco/cache/worktrees");
  });

  it("falls back to ~/.local/state/junco while it exists and ~/.junco has no tree", () => {
    // Scoped to the LEGACY root's own transcripts subdir (a flat marker) —
    // NOT a loose endsWith, which would also match "/h/.junco/transcripts"
    // while probing the canonical root and spuriously mark it as holding a
    // tree.
    const existsFn = (p: string) =>
      p === "/h/.local/state/junco" || p === "/h/.local/state/junco/transcripts";
    const cfg = assembleConfig(ConfigSchema.parse({}), env, { existsFn });
    expect(cfg.dataDir).toBe("/h/.local/state/junco");
    expect(cfg.dataLayout).toBe("flat");
    expect(cfg.legacy.dataRoot).toBe(true);
    expect(cfg.worktreeRoot).toBe("/h/.local/state/junco/worktrees");
  });

  it("a legacy-fallback root with NO recognized flat marker still resolves flat (I1 ruling)", () => {
    // Only the legacy root ITSELF exists — none of layoutOf's six markers
    // (queue/data/cache/transcripts/history for hasTree; the flat-marker set
    // for layoutOf) are present. This is the pre-#194 / never-populated-root
    // case: layoutOf alone would call this "v2" (marker-less default), and
    // startup's migrateStateTree would then relocate this root's
    // pre-unification dirs into data/-shaped destinations before any
    // operator ever ran `junco data migrate` — the exact hole this ruling
    // closes. legacyDataRoot === true is definitional: a v2 tree cannot live
    // at the legacy path (P2.T5 hasn't shipped the migrate-to-v2 move yet),
    // so the fallback forces "flat" outright rather than trusting the probe.
    const existsFn = (p: string) => p === "/h/.local/state/junco";
    const cfg = assembleConfig(ConfigSchema.parse({}), env, { existsFn });
    expect(cfg.dataDir).toBe("/h/.local/state/junco");
    expect(cfg.legacy.dataRoot).toBe(true);
    expect(cfg.dataLayout).toBe("flat");
    // And the derived paths follow: no data/cache/logs prefix.
    expect(cfg.worktreeRoot).toBe("/h/.local/state/junco/worktrees");
  });

  it("prefers ~/.junco once it holds a tree, even while the legacy root lingers", () => {
    const existsFn = (p: string) =>
      p === "/h/.junco/queue" || p === "/h/.junco/data" || p === "/h/.local/state/junco";
    const cfg = assembleConfig(ConfigSchema.parse({}), env, { existsFn });
    expect(cfg.dataDir).toBe("/h/.junco");
    expect(cfg.dataLayout).toBe("v2");
    expect(cfg.legacy.dataRoot).toBe(false);
  });

  it("an explicit dataDir is honored with its detected layout, no fallback probing", () => {
    const existsFn = (p: string) => p === "/custom/history"; // flat marker
    const cfg = assembleConfig(ConfigSchema.parse({ dataDir: "/custom" }), env, { existsFn });
    expect(cfg.dataDir).toBe("/custom");
    expect(cfg.dataLayout).toBe("flat");
    expect(cfg.legacy.dataRoot).toBe(false);
  });

  it("legacy.dataRoot triggers a 'junco data migrate' deprecation hint", () => {
    const existsFn = (p: string) => p === "/h/.local/state/junco";
    const cfg = assembleConfig(ConfigSchema.parse({}), env, { existsFn });
    const warns = configDeprecations(cfg);
    expect(warns.some((w) => w.includes("junco data migrate") && w.includes("~/.junco"))).toBe(
      true,
    );
  });
});

describe("homeOf", () => {
  it("env.HOME (trimmed, non-empty) wins over os.homedir()", () => {
    expect(homeOf({ HOME: "/h" })).toBe("/h");
    expect(homeOf({})).toBe(homedir());
    expect(homeOf({ HOME: "  " })).toBe(homedir());
  });
});

describe("dataRootHasTree", () => {
  it("true when queue/data/cache/transcripts/history is present, false otherwise", () => {
    expect(dataRootHasTree("/r", () => false)).toBe(false);
    expect(dataRootHasTree("/r", (p) => p === "/r/queue")).toBe(true);
    expect(dataRootHasTree("/r", (p) => p === "/r/data")).toBe(true);
    expect(dataRootHasTree("/r", (p) => p === "/r/cache")).toBe(true);
    expect(dataRootHasTree("/r", (p) => p === "/r/transcripts")).toBe(true);
    expect(dataRootHasTree("/r", (p) => p === "/r/history")).toBe(true);
    // config.json/gh alone do NOT count.
    expect(dataRootHasTree("/r", (p) => p === "/r/config.json" || p === "/r/gh")).toBe(false);
  });
});

describe("layoutOf", () => {
  it("data/ or cache/ present → v2", () => {
    expect(layoutOf("/r", (p) => p === "/r/data")).toBe("v2");
    expect(layoutOf("/r", (p) => p === "/r/cache")).toBe("v2");
  });

  it("a flat marker (transcripts|history|clones|worktrees|assess-history|github-cache) → flat", () => {
    for (const marker of [
      "transcripts",
      "history",
      "clones",
      "worktrees",
      "assess-history",
      "github-cache",
    ]) {
      expect(layoutOf("/r", (p) => p === `/r/${marker}`)).toBe("flat");
    }
  });

  it("nothing present → v2 (fresh roots get the final shape)", () => {
    expect(layoutOf("/r", () => false)).toBe("v2");
  });

  it("queue/review/watchlist.json are NOT markers — identical in both layouts", () => {
    expect(
      layoutOf("/r", (p) => p === "/r/queue" || p === "/r/review" || p === "/r/watchlist.json"),
    ).toBe("v2");
  });
});

describe("[github] config section", () => {
  it("defaults: disabled, junco labels, 60s poll, no repos", () => {
    // Fresh machine (existsFn: () => false): dataDir defaults to ~/.junco
    // (v2 layout), so externalReposRoot picks up the cache/ prefix.
    const cfg = assembleConfig(
      ConfigSchema.parse({ vaultRoot: "/tmp/v" }),
      {},
      {
        existsFn: () => false,
      },
    );
    expect(cfg.github).toEqual({
      enabled: false,
      triggerLabel: "junco",
      askLabel: "junco:ask",
      pollIntervalSeconds: 60,
      repos: [],
      requireApproval: true,
      plannerModelId: null,
      externalReposRoot: join(homedir(), ".junco/cache/clones/external"),
    });
  });

  it("parses requireApproval and plannerModelId", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/tmp/v",
        github: { requireApproval: false, plannerModelId: "prov/big" },
      }),
    );
    expect(cfg.github.requireApproval).toBe(false);
    expect(cfg.github.plannerModelId).toBe("prov/big");
  });

  it("rejects an empty plannerModelId", () => {
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/tmp/v", github: { plannerModelId: "" } })),
    ).toThrow();
  });

  it("parses repos and derives askLabel from a custom trigger", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/tmp/v",
        github: {
          enabled: true,
          triggerLabel: "bot",
          repos: [{ nwo: "acme/api", path: "~/code/api" }],
        },
      }),
    );
    expect(cfg.github.enabled).toBe(true);
    expect(cfg.github.askLabel).toBe("bot:ask");
    expect(cfg.github.repos).toHaveLength(1);
    expect(cfg.github.repos[0].nwo).toBe("acme/api");
    expect(cfg.github.repos[0].path).toBe(join(homedir(), "code/api")); // ~ expanded
  });

  it("an explicit askLabel overrides the derived one", () => {
    const cfg = loadConfig(writeJson({ vaultRoot: "/tmp/v", github: { askLabel: "question" } }));
    expect(cfg.github.askLabel).toBe("question");
  });

  it("rejects a malformed nwo", () => {
    expect(() =>
      loadConfig(
        writeJson({ vaultRoot: "/tmp/v", github: { repos: [{ nwo: "no-slash", path: "/x" }] } }),
      ),
    ).toThrow(/owner\/repo/);
  });
});

describe("github.externalReposRoot", () => {
  it("defaults to <dataDir>/clones/external", () => {
    // existsFn: () => false — hermetic (see the identical rationale on
    // "expands ~ in path fields..." above; proven against the committed code
    // in review: `mkdir -p /tmp/junco-state/transcripts` flips this
    // assertion under real existsSync).
    const cfg = assembleConfig(
      ConfigSchema.parse({
        vaultRoot: "/tmp/vault",
        observability: { stateDir: "/tmp/junco-state" },
      }),
      {},
      { existsFn: () => false },
    );
    // "/tmp/junco-state" is a fresh (never-created) explicit root — the
    // layout flip defaults it to v2 (cache/clones/external) too: an explicit
    // dataDir/stateDir is honored with its DETECTED layout, and a marker-less
    // root detects as v2.
    expect(cfg.github.externalReposRoot).toBe("/tmp/junco-state/cache/clones/external");
  });

  it("expands ~ in an explicit value", () => {
    const cfg = loadConfig(
      writeJson({ vaultRoot: "/tmp/vault", github: { externalReposRoot: "~/ext-clones" } }),
    );
    expect(cfg.github.externalReposRoot).toBe(join(homedir(), "ext-clones"));
  });
});

describe("[assess] config section", () => {
  it("defaults: maxIssuesPerRun 20, minSeverity low, npmBin npm, fileAs me", () => {
    const cfg = loadConfig(writeJson({ vaultRoot: "/tmp/v" }));
    expect(cfg.assess).toEqual({
      maxIssuesPerRun: 20,
      minSeverity: "low",
      npmBin: "npm",
      fileAs: "me",
    });
  });

  it("parses explicit assess values", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/tmp/v",
        assess: { maxIssuesPerRun: 5, minSeverity: "high", npmBin: "pnpm", fileAs: "bot" },
      }),
    );
    expect(cfg.assess).toEqual({
      maxIssuesPerRun: 5,
      minSeverity: "high",
      npmBin: "pnpm",
      fileAs: "bot",
    });
  });

  it('rejects fileAs = "daemon" (enum validation)', () => {
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/tmp/v", assess: { fileAs: "daemon" } })),
    ).toThrow();
  });

  it("rejects maxIssuesPerRun = 0 (min(1))", () => {
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/tmp/v", assess: { maxIssuesPerRun: 0 } })),
    ).toThrow();
  });

  it("rejects minSeverity = extreme (enum validation)", () => {
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/tmp/v", assess: { minSeverity: "extreme" } })),
    ).toThrow();
  });
});

describe("botAccount config", () => {
  it("defaults to disabled with the standard config dir", () => {
    const cfg = assembleConfig(ConfigSchema.parse({ vaultRoot: "/tmp/v" }));
    expect(cfg.botAccount.enabled).toBe(false);
    expect(cfg.botAccount.configDir).toBe(expandHome("~/.config/junco/gh"));
    expect(cfg.ghAuth).toBeUndefined();
  });

  it("expands ~ in botAccount.configDir and honors enabled", () => {
    const cfg = assembleConfig(
      ConfigSchema.parse({
        vaultRoot: "/tmp/v",
        botAccount: { enabled: true, configDir: "~/custom/gh" },
      }),
    );
    expect(cfg.botAccount.enabled).toBe(true);
    expect(cfg.botAccount.configDir).toBe(expandHome("~/custom/gh"));
  });
});

describe("isLoopbackHost (#44)", () => {
  it("treats localhost / 127.0.0.0-8 / ::1 as loopback", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("  127.0.0.1  ")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });

  it("treats 0.0.0.0 / LAN IPs / :: as non-loopback", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });
});

describe("resolveConfigPath / juncoHome / legacyConfigPath", () => {
  it("juncoHome anchors to env.HOME and falls back to os.homedir()", () => {
    expect(juncoHome({ HOME: "/h" })).toBe("/h/.junco");
    expect(juncoHome({})).toBe(join(homedir(), ".junco"));
    expect(juncoHome({ HOME: "  " })).toBe(join(homedir(), ".junco"));
  });

  it("canonical config path is ~/.junco/config.json", () => {
    expect(defaultUserConfigPath({ HOME: "/h" })).toBe("/h/.junco/config.json");
  });

  it("resolution is cwd-independent — a cwd config.json can never win", () => {
    // existsFn claiming EVERY path exists: the canonical still wins. There is
    // no cwd seam left in ResolveConfigDeps for a cwd lookup to use.
    expect(resolveConfigPath({ existsFn: () => true, env: { HOME: "/h" } })).toBe(
      "/h/.junco/config.json",
    );
  });

  it("falls back to the legacy XDG path only while the canonical file is absent", () => {
    const env = { HOME: "/h", XDG_CONFIG_HOME: "/xdg" };
    expect(resolveConfigPath({ existsFn: (p) => p === "/xdg/junco/config.json", env })).toBe(
      "/xdg/junco/config.json",
    );
    expect(resolveConfigPath({ existsFn: () => false, env })).toBe("/h/.junco/config.json");
  });

  it("legacyConfigPath honors XDG_CONFIG_HOME and falls back to ~/.config", () => {
    expect(legacyConfigPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/junco/config.json");
    expect(legacyConfigPath({})).toBe(join(homedir(), ".config/junco/config.json"));
    expect(legacyConfigPath({ XDG_CONFIG_HOME: "  ", HOME: "/h" })).toBe(
      "/h/.config/junco/config.json",
    );
  });
});

describe("queuePaths", () => {
  it("derives queue paths under queueRoot", () => {
    const paths = queuePaths({ queueRoot: "/v/Junco" } as any);
    expect(paths.inbox).toBe("/v/Junco/inbox");
    expect(paths.failed).toBe("/v/Junco/failed");
  });
});

describe("resolveApiKey", () => {
  it("passes a literal key through", () => {
    expect(resolveApiKey("sk-live-123", {})).toBe("sk-live-123");
  });

  it("returns null when unset (defer to provider env at request time)", () => {
    expect(resolveApiKey(undefined, {})).toBeNull();
  });

  it("interpolates an exact $VAR reference from the daemon env", () => {
    expect(resolveApiKey("$MY_PROVIDER_KEY", { MY_PROVIDER_KEY: "sk-env-9" })).toBe("sk-env-9");
  });

  it("throws a config error when the referenced $VAR is unset or empty", () => {
    expect(() => resolveApiKey("$MISSING_KEY", {})).toThrow(/config: model\.apiKey.*MISSING_KEY/);
    expect(() => resolveApiKey("$EMPTY_KEY", { EMPTY_KEY: "" })).toThrow(/EMPTY_KEY/);
  });

  it("rejects !command values — junco never shell-executes config values", () => {
    expect(() => resolveApiKey("!op read secret", {})).toThrow(/config: model\.apiKey.*!command/);
  });

  it('schema-level: rejects a "!command" apiKey at parse time, env-independent', () => {
    // Defense in depth (item 2): resolveApiKey's own throw only fires at
    // assembly time (needs the daemon env); the schema rejects the shape at
    // WRITE time too, so `junco config set` / the TUI editor / any
    // validateConfigObject caller fails loud before the value ever reaches
    // disk.
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/v", model: { apiKey: "!op read secret" } })),
    ).toThrow(/model\.apiKey.*!command/);
  });

  it("treats a non-env-shaped $ string as a literal", () => {
    expect(resolveApiKey("$not-an-env-ref", {})).toBe("$not-an-env-ref");
  });
});

describe("hosted model config (source / baseUrlExplicit / apiKey / retry)", () => {
  it("defaults stay local-first: source auto, local default baseUrl, placeholder key", () => {
    const cfg = loadConfig(writeJson({ vaultRoot: "/tmp/vault" }));
    expect(cfg.model.source).toBe("auto");
    expect(cfg.model.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(cfg.model.baseUrlExplicit).toBe(false);
    expect(cfg.model.apiKey).toBe("1234");
    expect(cfg.model.retry).toEqual({ maxRetries: null, baseDelayMs: null });
  });

  it("a hosted id with no baseUrl and no key resolves apiKey to null (env fallback)", () => {
    const cfg = loadConfig(
      writeJson({ vaultRoot: "/tmp/vault", model: { id: "anthropic/claude-sonnet-4-5" } }),
    );
    expect(cfg.model.baseUrlExplicit).toBe(false);
    expect(cfg.model.apiKey).toBeNull();
  });

  it("an explicit baseUrl keeps the inline placeholder key (proxy/override)", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/tmp/vault",
        model: { id: "anthropic/claude-sonnet-4-5", baseUrl: "http://10.0.0.5:8080/v1" },
      }),
    );
    expect(cfg.model.baseUrlExplicit).toBe(true);
    expect(cfg.model.apiKey).toBe("1234");
  });

  it("interpolates $VAR keys through the injectable env", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/tmp/vault",
        model: { id: "anthropic/claude-sonnet-4-5", apiKey: "$PROVIDER_KEY" },
      }),
      { PROVIDER_KEY: "sk-real" },
    );
    expect(cfg.model.apiKey).toBe("sk-real");
  });

  it("parses retry levers and defaults them to null", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/tmp/vault",
        model: { retry: { maxRetries: 5, baseDelayMs: 500 } },
      }),
    );
    expect(cfg.model.retry).toEqual({ maxRetries: 5, baseDelayMs: 500 });
  });
});

describe("worker.endpointProbe", () => {
  it("defaults to auto", () => {
    const cfg = loadConfig(writeJson({ vaultRoot: "/tmp/vault" }));
    expect(cfg.endpointProbe).toBe("auto");
  });

  it("parses always and never", () => {
    expect(
      loadConfig(writeJson({ vaultRoot: "/v", worker: { endpointProbe: "always" } })).endpointProbe,
    ).toBe("always");
    expect(
      loadConfig(writeJson({ vaultRoot: "/v", worker: { endpointProbe: "never" } })).endpointProbe,
    ).toBe("never");
  });

  it("rejects an unrecognized value", () => {
    expect(() =>
      loadConfig(writeJson({ vaultRoot: "/v", worker: { endpointProbe: "sometimes" } })),
    ).toThrow();
  });
});

describe("dataDir resolution (unified data root)", () => {
  const FRESH_DEFAULT = join(homedir(), ".junco");
  // existsFn: () => false — a fresh machine, deterministic regardless of
  // what the machine running the suite actually has on disk (see homeOf).
  const parse = (raw: object) =>
    assembleConfig(ConfigSchema.parse(raw), {}, { existsFn: () => false });

  it("defaults dataDir to ~/.junco with a v2 layout and derives every root", () => {
    const cfg = parse({});
    expect(cfg.dataDir).toBe(FRESH_DEFAULT);
    expect(cfg.dataLayout).toBe("v2");
    expect(cfg.queueRoot).toBe(join(FRESH_DEFAULT, "queue"));
    expect(cfg.worktreeRoot).toBe(join(FRESH_DEFAULT, "cache/worktrees"));
    expect(cfg.github.externalReposRoot).toBe(join(FRESH_DEFAULT, "cache/clones/external"));
    expect(cfg.legacy).toEqual({
      vaultRoot: false,
      stateDir: false,
      worktreeRoot: false,
      externalReposRoot: false,
      dataRoot: false,
    });
  });

  it("explicit dataDir moves every derived root", () => {
    const cfg = parse({ dataDir: "~/jdata" });
    const root = join(homedir(), "jdata");
    expect(cfg.dataDir).toBe(root);
    expect(cfg.dataLayout).toBe("v2"); // fresh (marker-less) explicit root
    expect(cfg.queueRoot).toBe(join(root, "queue"));
    expect(cfg.worktreeRoot).toBe(join(root, "cache/worktrees"));
    expect(cfg.github.externalReposRoot).toBe(join(root, "cache/clones/external"));
  });

  it("legacy vaultRoot/juncoSubdir wins the queue root only", () => {
    const cfg = parse({ dataDir: "~/jdata", vaultRoot: "~/vault", juncoSubdir: "Junco" });
    expect(cfg.queueRoot).toBe(join(homedir(), "vault", "Junco"));
    expect(cfg.dataDir).toBe(join(homedir(), "jdata")); // untouched
    expect(cfg.legacy.vaultRoot).toBe(true);
  });

  it("legacy observability.stateDir wins over dataDir for the whole root", () => {
    const cfg = parse({ dataDir: "~/jdata", observability: { stateDir: "~/state" } });
    expect(cfg.dataDir).toBe(join(homedir(), "state"));
    expect(cfg.legacy.stateDir).toBe(true);
  });

  it("legacy git.worktreeRoot and github.externalReposRoot win their subtrees", () => {
    const cfg = parse({
      git: { worktreeRoot: "~/wt" },
      github: { externalReposRoot: "~/ext" },
    });
    expect(cfg.worktreeRoot).toBe(join(homedir(), "wt"));
    expect(cfg.github.externalReposRoot).toBe(join(homedir(), "ext"));
    expect(cfg.legacy.worktreeRoot).toBe(true);
    expect(cfg.legacy.externalReposRoot).toBe(true);
  });

  it("empty-string legacy path keys are treated as unset — flag and resolution agree (#198)", () => {
    const cfg = parse({
      vaultRoot: "",
      observability: { stateDir: "" },
      git: { worktreeRoot: "" },
    });
    expect(cfg.legacy).toEqual({
      vaultRoot: false,
      stateDir: false,
      worktreeRoot: false,
      externalReposRoot: false,
      dataRoot: false,
    });
    expect(cfg.dataDir).toBe(FRESH_DEFAULT);
    expect(cfg.queueRoot).toBe(join(FRESH_DEFAULT, "queue"));
    expect(cfg.worktreeRoot).toBe(join(FRESH_DEFAULT, "cache/worktrees"));
  });

  it("whitespace-only legacy path keys are unset too, including externalReposRoot (min(1) admits it) (#198)", () => {
    const cfg = parse({
      vaultRoot: "  ",
      git: { worktreeRoot: " " },
      github: { externalReposRoot: "  " },
    });
    expect(cfg.legacy).toEqual({
      vaultRoot: false,
      stateDir: false,
      worktreeRoot: false,
      externalReposRoot: false,
      dataRoot: false,
    });
    expect(cfg.worktreeRoot).toBe(join(FRESH_DEFAULT, "cache/worktrees"));
    expect(cfg.github.externalReposRoot).toBe(join(FRESH_DEFAULT, "cache/clones/external"));
  });

  it("configDeprecations names each set legacy key and is empty when clean", () => {
    expect(configDeprecations(parse({}))).toEqual([]);
    const warns = configDeprecations(
      parse({ vaultRoot: "~/vault", observability: { stateDir: "~/state" } }),
    );
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain("vaultRoot");
    expect(warns[1]).toContain("stateDir");
    for (const w of warns) expect(w).toContain("junco data migrate");
  });

  it("configDeprecations: git.worktreeRoot gets a remove-the-key hint, NOT the migrate hint (migrate doesn't move worktrees)", () => {
    const warns = configDeprecations(parse({ git: { worktreeRoot: "~/wt" } }));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("git.worktreeRoot");
    expect(warns[0]).toContain("remove the key");
    expect(warns[0]).toContain("<dataDir>/worktrees");
    // 'junco data migrate' does NOT unify this key — pointing at it loops the
    // operator (the warning would survive the migrate forever).
    expect(warns[0]).not.toContain("junco data migrate");
  });

  it("configDeprecations: github.externalReposRoot gets a remove-the-key hint, NOT the migrate hint", () => {
    const warns = configDeprecations(parse({ github: { externalReposRoot: "~/ext" } }));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("github.externalReposRoot");
    expect(warns[0]).toContain("remove the key");
    expect(warns[0]).toContain("<dataDir>/clones/external");
    expect(warns[0]).not.toContain("junco data migrate");
  });

  it("a config with no keys at all is valid (vaultRoot no longer required)", () => {
    expect(() => ConfigSchema.parse({})).not.toThrow();
  });
});
