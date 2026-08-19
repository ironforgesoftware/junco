/**
 * tests/helpers/config.ts — the single full `Config` literal in the suite.
 *
 * Replaces 19 near-identical ~83-line copies. Derived mechanically from those
 * 19: 71 key paths, 50 byte-identical (ballast, below), 21 varying. Of the
 * varying, TEN are semantic and are REQUIRED seams the call site must state —
 * a test must never silently inherit a value that changes what is under test.
 * Three others (model.id/apiKey/baseUrl) were pure spelling noise ("m", "k",
 * "u" vs "test-model", "test-key") and are canonicalized here.
 *
 * ADDING A CONFIG FIELD? Add it HERE and nowhere else. If its value would
 * change what a test is exercising, add it to `ConfigSeams` instead so every
 * call site has to state it.
 *
 * Spec: docs/superpowers/specs/2026-07-21-test-suite-consolidation-design.md §1.1
 */
import type { Config } from "../../src/types.js";

/** The Q&A read-only tool default. Widening this is a hard-contract violation. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

/**
 * The ten keys whose value changes what is under test. All required — omission
 * is a type error, which is the point.
 */
export interface ConfigSeams {
  /** Unified data root. Prefer a synthetic /sbxroot/... path over a real one. */
  dataDir: string;
  queueRoot: string;
  worktreeRoot: string;
  /** [] for PR flows, READ_ONLY_TOOLS for Q&A. Never widen the Q&A default. */
  tools: string[];
  criticEnabled: boolean;
  planLintEnabled: boolean;
  verifyEnabled: boolean;
  supervisorEnabled: boolean;
  healthEnabled: boolean;
  removeWorktreeOnSuccess: boolean;
}

export function makeConfig(seams: ConfigSeams, overrides: Partial<Config> = {}): Config {
  return {
    // ---- required seams ----
    dataDir: seams.dataDir,
    queueRoot: seams.queueRoot,
    worktreeRoot: seams.worktreeRoot,
    tools: seams.tools,
    criticEnabled: seams.criticEnabled,
    planLintEnabled: seams.planLintEnabled,
    verifyEnabled: seams.verifyEnabled,
    supervisorEnabled: seams.supervisorEnabled,
    healthEnabled: seams.healthEnabled,
    removeWorktreeOnSuccess: seams.removeWorktreeOnSuccess,

    // ---- poison default ----
    // NOT "gh". A test that needs gh must point this at its own fake script; one
    // that forgets must fail loudly rather than shelling out to the maintainer's
    // real, authenticated gh (this repo doubles as a live runtime).
    ghBin: "/nonexistent/gh",

    // ---- ballast: identical across all 19 former helpers ----
    dataLayout: "v2",
    legacy: {
      vaultRoot: false,
      stateDir: false,
      worktreeRoot: false,
      externalReposRoot: false,
      dataRoot: false,
      ghConfigDir: false,
    },
    model: {
      id: "test/model",
      source: "auto",
      baseUrlExplicit: false,
      retry: { maxRetries: null, baseDelayMs: null },
      modelsJson: null,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "test-key",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 131072,
      maxTokens: 49152,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevel: "medium",
      compat: { maxTokensField: "max_tokens", thinkingFormat: "qwen-chat-template" },
    },
    defaultTimeoutMinutes: 30,
    pollIntervalSeconds: 15,
    startupPollSeconds: 30,
    startupWait: true,
    endpointProbe: "auto",
    maxTransientRetries: 2,
    retryBackoffSeconds: 60,
    maxConcurrent: 1,
    supervisorBudgetPerKind: 1,
    supervisorEscalationWindow: 3,
    supervisorOutputBudgetPerTurn: 12000,
    supervisorOutputBudgetPostCommit: 24000,
    gitBin: "git",
    defaultBaseBranch: "main",
    branchPrefix: "junco/",
    allowedRepoRoots: [],
    draftByDefault: true,
    defaultLabels: [],
    verifyCommandTimeout: 60,
    verifyBlockOnFail: false,
    criticMaxRetries: 1,
    criticThinking: "minimal",
    planLintBlockOnError: false,
    planLintCheckLabels: false,
    commitLeftoversEnabled: false,
    dailyBudgetUsd: 0,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    logLevel: "info",
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
      externalReposRoot: "/sbxroot/external",
    },
    assess: { maxIssuesPerRun: 20, minSeverity: "low", npmBin: "npm", fileAs: "me" },
    skills: { harnessDirs: [] },
    sandbox: {
      enabled: false,
      backend: "auto",
      network: "deny",
      extraDenyRead: [],
      extraAllowWrite: [],
    },
    botAccount: { enabled: false, configDir: "/sbxroot/junco-gh" },
    ...overrides,
  };
}
