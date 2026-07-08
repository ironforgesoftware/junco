/**
 * Tests for src/health.ts — endpointReachable + waitForEndpoint.
 * Written FIRST (TDD). No real network, no real delays.
 *
 * Port of worker.py omlx_reachable / wait_for_omlx (now endpoint-named).
 */

import { describe, it, expect } from "vitest";
import type { Config } from "../src/types.js";
import type { StopFlagLike } from "../src/health.js";
import { endpointReachable, waitForEndpoint } from "../src/health.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    vaultRoot: "/tmp/vault",
    juncoSubdir: "Junco",
    model: {
      id: "omlx/test-model",
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
    },
    ...overrides,
  };
}

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
});
