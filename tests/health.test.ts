/**
 * Tests for src/health.ts — endpointReachable + waitForEndpoint.
 * Written FIRST (TDD). No real network, no real delays.
 *
 * Port of worker.py omlx_reachable / wait_for_omlx (now endpoint-named).
 */

import { describe, it, expect, vi } from "vitest";
import type { Config, ModelConfig } from "../src/types.js";
import type { StopFlagLike } from "../src/health.js";
import { endpointReachable, waitForEndpoint, probePolicy, makeCachedProbe } from "../src/health.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    vaultRoot: "/tmp/vault",
    juncoSubdir: "Junco",
    model: {
      id: "omlx/test-model",
      source: "auto",
      // This fixture's baseUrl below IS explicit, so baseUrlExplicit is true —
      // otherwise catalogEligible's auto-heuristic (non-"local" provider + no
      // explicit baseUrl) would wrongly treat this inline/local model as
      // catalog-eligible and shouldProbeEndpoint would skip these tests' probe.
      baseUrlExplicit: true,
      retry: { maxRetries: null, baseDelayMs: null },
      modelsJson: null,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1234/v1/models",
      apiKey: "test-key",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 131072,
      maxTokens: 49152,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevel: "medium",
      compat: { maxTokensField: "max_tokens", thinkingFormat: "qwen-chat-template" },
    },
    tools: [],
    defaultTimeoutMinutes: 30,
    pollIntervalSeconds: 15,
    startupPollSeconds: 30,
    startupWait: true,
    maxTransientRetries: 2,
    retryBackoffSeconds: 60,
    maxConcurrent: 1,
    endpointProbe: "auto",
    supervisorEnabled: false,
    supervisorBudgetPerKind: 1,
    supervisorEscalationWindow: 3,
    supervisorOutputBudgetPerTurn: 12000,
    supervisorOutputBudgetPostCommit: 24000,
    gitBin: "git",
    ghBin: "gh",
    defaultBaseBranch: "main",
    branchPrefix: "junco/",
    worktreeRoot: "/tmp/worktrees",
    removeWorktreeOnSuccess: true,
    allowedRepoRoots: [],
    draftByDefault: true,
    defaultLabels: [],
    verifyEnabled: true,
    verifyCommandTimeout: 60,
    verifyBlockOnFail: false,
    criticEnabled: true,
    criticMaxRetries: 1,
    criticThinking: "minimal",
    planLintEnabled: true,
    planLintBlockOnError: true,
    planLintCheckLabels: true,
    commitLeftoversEnabled: false,
    dailyBudgetUsd: 0,
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    logLevel: "info",
    stateDir: "/tmp/vault/state",
    logToFile: false,
    transcriptsEnabled: false,
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
    assess: { maxIssuesPerRun: 20, minSeverity: "low", npmBin: "npm" },
    sandbox: {
      enabled: false,
      backend: "auto",
      network: "deny",
      extraDenyRead: [],
      extraAllowWrite: [],
    },
    ...overrides,
  };
}

/** A hosted catalog model: no local server to probe, apiKey deferred (null). */
function hostedModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: "anthropic/claude-x",
    source: "auto",
    baseUrlExplicit: false,
    retry: { maxRetries: null, baseDelayMs: null },
    modelsJson: null,
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1234/v1/models",
    apiKey: null,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 131072,
    maxTokens: 49152,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevel: "medium",
    compat: { maxTokensField: "max_tokens", thinkingFormat: "qwen-chat-template" },
    ...overrides,
  };
}

/** Any non-null models.json path forces a probe regardless of catalog
 * eligibility (shouldProbeEndpoint only checks truthiness — resolveProbeBaseUrl
 * handles a missing/unreadable file by falling back to base_url). */
const tmpModelsJson = "/tmp/junco-shouldprobe-does-not-exist-models.json";

// ---------------------------------------------------------------------------
// endpointReachable
// ---------------------------------------------------------------------------

describe("endpointReachable", () => {
  it("returns true when fetch returns ok:true", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;

    const fetchFn = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers as Record<string, string>;
      return { ok: true } as Response;
    };

    const cfg = makeConfig();
    const result = await endpointReachable(cfg, { fetchFn, timeoutMs: 1000 });

    expect(result).toBe(true);
    // probe URL should end with /models
    expect(capturedUrl).toMatch(/\/models$/);
    // should have Bearer auth header
    expect(capturedHeaders?.["Authorization"]).toBe("Bearer test-key");
  });

  it("returns false when fetch returns ok:false", async () => {
    const fetchFn = async (): Promise<Response> => ({ ok: false }) as Response;
    const cfg = makeConfig();
    const result = await endpointReachable(cfg, { fetchFn, timeoutMs: 1000 });
    expect(result).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    const fetchFn = async (): Promise<Response> => {
      throw new Error("Network error");
    };
    const cfg = makeConfig();
    const result = await endpointReachable(cfg, { fetchFn, timeoutMs: 1000 });
    expect(result).toBe(false);
  });

  it("returns true without fetching for catalog sources", async () => {
    const fetchFn = vi.fn();
    const cfg = makeConfig({ model: hostedModel() });
    await expect(endpointReachable(cfg, { fetchFn })).resolves.toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("omits the Authorization header when apiKey is null but a probe runs", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const cfg = makeConfig({ model: { ...hostedModel(), modelsJson: tmpModelsJson } });
    await endpointReachable(cfg, { fetchFn });
    const headers = fetchFn.mock.calls[0][1].headers;
    expect(headers.Authorization).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// waitForEndpoint
// ---------------------------------------------------------------------------

describe("waitForEndpoint", () => {
  it("returns immediately when startupWait is false", async () => {
    const cfg = makeConfig({ startupWait: false });
    const stopFlag: StopFlagLike = { requested: false };

    let fetchCalled = false;
    const fetchFn = async (): Promise<Response> => {
      fetchCalled = true;
      throw new Error("should not be called");
    };

    await waitForEndpoint(cfg, stopFlag, { fetchFn });
    expect(fetchCalled).toBe(false);
  });

  it("resolves once reachable after retries; sleep called twice; fetch called 3 times", async () => {
    const cfg = makeConfig({ startupWait: true, startupPollSeconds: 1 });
    const stopFlag: StopFlagLike = { requested: false };

    let fetchCallCount = 0;
    const fetchFn = async (): Promise<Response> => {
      fetchCallCount++;
      if (fetchCallCount <= 2) return { ok: false } as Response;
      return { ok: true } as Response;
    };

    let sleepCallCount = 0;
    const sleep = async (_seconds: number, _sf: StopFlagLike): Promise<void> => {
      sleepCallCount++;
    };

    await waitForEndpoint(cfg, stopFlag, { fetchFn, sleep });

    expect(fetchCallCount).toBe(3);
    expect(sleepCallCount).toBe(2);
  });

  it("exits loop when stop flag is set", async () => {
    const cfg = makeConfig({ startupWait: true, startupPollSeconds: 1 });
    const stop = { requested: false };

    const fetchFn = async (): Promise<Response> => ({ ok: false }) as Response;

    let sleepCallCount = 0;
    const sleep = async (_seconds: number, _sf: StopFlagLike): Promise<void> => {
      sleepCallCount++;
      // Set stop after the first sleep so the loop exits
      stop.requested = true;
    };

    await waitForEndpoint(cfg, stop, { fetchFn, sleep });

    // Should have fetched once, slept once, then checked stop.requested and exited
    expect(sleepCallCount).toBe(1);
    // Should NOT loop forever
  });

  it("returns immediately for catalog sources via its OWN skip guard", async () => {
    const cfg = makeConfig({ model: hostedModel() });
    // sleep/fetchFn-not-called alone cannot isolate waitForEndpoint's own
    // guard: were it deleted, endpointReachable's identical first-line guard
    // returns true on the first loop iteration without fetching, and both
    // spies stay uncalled anyway. The log line is what distinguishes the two
    // paths — the skip guard logs "startup wait skipped" and never enters the
    // loop; the loop path logs "inference endpoint reachable" instead.
    // (log.info spy pattern per daemon.test.ts; the stop-flipping sleep is a
    // safety net so a double-guard regression can't spin the loop forever.)
    const { log } = await import("../src/logging.js");
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      const stop = { requested: false };
      const fetchFn = vi.fn().mockResolvedValue({ ok: false });
      const sleep = vi.fn(async () => {
        stop.requested = true;
      });
      await waitForEndpoint(cfg, stop, { fetchFn, sleep });
      expect(sleep).not.toHaveBeenCalled();
      expect(fetchFn).not.toHaveBeenCalled();
      const msgs = infoSpy.mock.calls.map((c) => String(c[0]));
      expect(msgs).toContain("hosted provider (catalog) — endpoint startup wait skipped");
      expect(msgs.filter((m) => m.includes("inference endpoint reachable"))).toHaveLength(0);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('returns immediately for endpointProbe: "never", logging a generic skip line', async () => {
    const cfg = makeConfig({ endpointProbe: "never" });
    const { log } = await import("../src/logging.js");
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      const stop = { requested: false };
      const fetchFn = vi.fn().mockResolvedValue({ ok: false });
      const sleep = vi.fn(async () => {
        stop.requested = true;
      });
      await waitForEndpoint(cfg, stop, { fetchFn, sleep });
      expect(sleep).not.toHaveBeenCalled();
      expect(fetchFn).not.toHaveBeenCalled();
      const msgs = infoSpy.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes("endpointProbe=never"))).toBe(true);
      expect(msgs.filter((m) => m.includes("inference endpoint reachable"))).toHaveLength(0);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// probePolicy
// ---------------------------------------------------------------------------

describe("probePolicy", () => {
  it('"never" is false regardless of the model', () => {
    expect(probePolicy(makeConfig({ endpointProbe: "never" }))).toBe(false);
    expect(probePolicy(makeConfig({ endpointProbe: "never", model: hostedModel() }))).toBe(false);
  });

  it('"always" is true regardless of the model', () => {
    expect(probePolicy(makeConfig({ endpointProbe: "always" }))).toBe(true);
    expect(probePolicy(makeConfig({ endpointProbe: "always", model: hostedModel() }))).toBe(true);
  });

  it('"auto" delegates to shouldProbeEndpoint (local probes, hosted catalog skips)', () => {
    expect(probePolicy(makeConfig({ endpointProbe: "auto" }))).toBe(true);
    expect(probePolicy(makeConfig({ endpointProbe: "auto", model: hostedModel() }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// endpointReachable — endpointProbe policy overrides
// ---------------------------------------------------------------------------

describe("endpointReachable — endpointProbe policy", () => {
  it('"never" skips the probe even for a local (normally-probed) config', async () => {
    const fetchFn = vi.fn();
    const cfg = makeConfig({ endpointProbe: "never" });
    await expect(endpointReachable(cfg, { fetchFn })).resolves.toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('"always" probes even a hosted-catalog config that "auto" would skip', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const cfg = makeConfig({ model: hostedModel(), endpointProbe: "always" });
    await expect(endpointReachable(cfg, { fetchFn })).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// makeCachedProbe
// ---------------------------------------------------------------------------

describe("makeCachedProbe", () => {
  it("does not re-invoke the probe for a second call within the TTL", async () => {
    let now = 1_000;
    let calls = 0;
    const probe = async (): Promise<boolean> => {
      calls++;
      return true;
    };
    const cached = makeCachedProbe(probe, 10_000, () => now);

    await expect(cached()).resolves.toBe(true);
    now += 5_000;
    await expect(cached()).resolves.toBe(true);
    expect(calls).toBe(1);
  });

  it("re-invokes the probe once the TTL has expired", async () => {
    let now = 1_000;
    let calls = 0;
    const probe = async (): Promise<boolean> => {
      calls++;
      return true;
    };
    const cached = makeCachedProbe(probe, 10_000, () => now);

    await expect(cached()).resolves.toBe(true);
    now += 10_001;
    await expect(cached()).resolves.toBe(true);
    expect(calls).toBe(2);
  });

  it("dedupes concurrent callers into a single in-flight probe invocation", async () => {
    let calls = 0;
    let resolveProbe: (v: boolean) => void = () => {};
    const deferred = new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    });
    const probe = (): Promise<boolean> => {
      calls++;
      return deferred;
    };
    const cached = makeCachedProbe(probe);

    const p1 = cached();
    const p2 = cached();
    resolveProbe(true);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(calls).toBe(1);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
  });

  it("treats a rejected probe as false, cached for the TTL", async () => {
    let now = 1_000;
    let calls = 0;
    const probe = async (): Promise<boolean> => {
      calls++;
      throw new Error("boom");
    };
    const cached = makeCachedProbe(probe, 10_000, () => now);

    await expect(cached()).resolves.toBe(false);
    now += 5_000;
    await expect(cached()).resolves.toBe(false);
    expect(calls).toBe(1);
  });
});
