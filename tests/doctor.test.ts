import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, type DoctorDeps } from "../src/doctor.js";
import { writeWatchlist } from "../src/watchlist.js";
import { outboxPaths } from "../src/githubOutbox.js";
import { writePending } from "../src/assessReview.js";
import { writeDraft } from "../src/commentReview.js";
import type { Config } from "../src/types.js";
import type { ResolvedModelInfo } from "../src/agent/session.js";

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
    ...over,
  };
}

describe("runDoctor", () => {
  it("all green → exit 0", async () => {
    expect(await runDoctor("/x/config.json", deps())).toBe(0);
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
    expect(lines.join("\n")).not.toMatch(/inference endpoint/i);
    expect(lines.join("\n")).toMatch(/model — anthropic\/claude-x resolves via catalog/i);
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
    expect(lines.join("\n")).toMatch(
      /inference endpoint.*probe disabled.*worker\.endpointProbe=never/i,
    );
    expect(lines.join("\n")).not.toMatch(/catalog-eligible/i);
  });

  it("does not report sandbox when disabled (default)", async () => {
    const lines: string[] = [];
    await runDoctor("/x/config.json", deps({ printFn: (s) => lines.push(s) }));
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
    expect(lines.join("\n")).toMatch(/✗ model — no catalog match for anthropic\/claude-x/);
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
    expect(lines.join("\n")).toMatch(/✓ key source — config literal \(model\.apiKey\)/);
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
    expect(lines.join("\n")).toMatch(
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
    expect(lines.join("\n")).toMatch(/✓ key source — ANTHROPIC_API_KEY present in the environment/);
    // apiKey is null → the auth check has nothing to send, so it notes that
    // instead of silently skipping.
    expect(lines.join("\n")).toMatch(/⚠ auth — no key configured/);
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
    expect(lines.join("\n")).toMatch(
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
    expect(lines.join("\n")).toMatch(/✓ auth — auth verified/);
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
            baseUrl: "https://generativelanguage.googleapis.com",
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
    expect(lines.join("\n")).toMatch(/✗ auth — auth rejected \(check the key\)/);
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
    expect(lines.join("\n")).toMatch(/✗ auth — auth rejected \(check the key\)/);
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
    expect(lines.join("\n")).toMatch(/⚠ auth — endpoint unreachable/);
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
    expect(lines.join("\n")).toMatch(
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
    expect(lines.join("\n")).not.toMatch(/auth —/);
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
    expect(lines.join("\n")).not.toMatch(/planner model/);
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
    expect(lines.join("\n")).toMatch(/✓ planner model — openai\/gpt-4o resolves via catalog/);
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
    expect(lines.join("\n")).toMatch(
      /⚠ planner model — no catalog match for openai\/does-not-exist/,
    );
  });

  it("local config: byte-identical output — no hosted-preflight lines leak in (regression)", async () => {
    const lines: string[] = [];
    const code = await runDoctor("/x/config.json", deps({ printFn: (s) => lines.push(s) }));
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).not.toMatch(/resolves via/);
    expect(out).not.toMatch(/key source/);
    expect(out).not.toMatch(/planner model/);
    expect(out).not.toMatch(/✓ auth —|✗ auth —|⚠ auth —/);
    expect(out).toMatch(/ready — 0 failure\(s\), 0 warning\(s\)/);
  });
});

describe("runDoctor github checks", () => {
  it("disabled bridge → no github lines at all", async () => {
    const lines: string[] = [];
    await runDoctor("/x/config.json", deps({ printFn: (s) => lines.push(s) }));
    expect(lines.join("")).not.toMatch(/github/);
  });

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
    writeWatchlist(join(stateDir, "github-watchlist.json"), [
      { nwo: "alx/coral", path: "/tmp/coral" },
    ]);
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.json",
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
    const code = await runDoctor("/x/config.json", deps({ printFn: (s) => lines.push(s) }));
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
      "/x/config.json",
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
      "/x/config.json",
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
    const code = await runDoctor("/x/config.json", deps({ printFn: (s) => lines.push(s) }));
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
      "/x/config.json",
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
    const code = await runDoctor("/x/config.json", deps({ printFn: (s) => lines.push(s) }));
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
      "/x/config.json",
      deps({ loadConfigFn: () => ({ ...okConfig, stateDir }), printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(0);
    // okConfig has github.enabled = false — the draft count must still surface.
    expect(lines.join("")).toMatch(/✓ analyze drafts — 1 pending \(junco analyze review\)/);
    expect(lines.join("")).toMatch(/0 warning\(s\)/);
  });
});
