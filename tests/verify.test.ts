import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractVerificationBlocks,
  runSpecVerification,
  MAX_VERIFICATION_BLOCKS,
  VERIFICATION_MAX_TOTAL_MS,
} from "../src/verify.js";
import type { Config, Ticket } from "../src/types.js";

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    dataDir: "/tmp/vault/state",
    queueRoot: "/tmp/vault/Junco",
    legacy: { vaultRoot: false, stateDir: false, worktreeRoot: false, externalReposRoot: false },
    model: {
      id: "test/model",
      source: "auto",
      baseUrlExplicit: false,
      retry: { maxRetries: null, baseDelayMs: null },
      modelsJson: null,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "test",
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
    endpointProbe: "auto",
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
    verifyCommandTimeout: 10,
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
    botAccount: { enabled: false, configDir: "/tmp/junco-gh" },
    ...overrides,
  };
}

function makeTicket(body: string): Ticket {
  return {
    path: "/tmp/ticket.md",
    id: "T01",
    priority: "normal" as const,
    timeoutSeconds: 60,
    body,
    frontmatter: {},
    hasRepo: false,
    notBefore: null,
    retryCount: 0,
    tools: null,
    github: null,
    assess: null,
    analyze: null,
    workdir: null,
    network: null,
  };
}

// ---------------------------------------------------------------------------
// Temp worktree
// ---------------------------------------------------------------------------

let wtPath: string;

beforeEach(() => {
  wtPath = mkdtempSync(join(tmpdir(), "junco-verify-"));
});

afterEach(() => {
  rmSync(wtPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractVerificationBlocks
// ---------------------------------------------------------------------------

describe("extractVerificationBlocks", () => {
  it("returns the block text from a ## Verification section", () => {
    const body = `
# My Ticket

## Steps
Do things.

## Verification

\`\`\`bash
echo hello
test -f README.md
\`\`\`
`;
    const blocks = extractVerificationBlocks(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("echo hello");
    expect(blocks[0]).toContain("test -f README.md");
  });

  it("returns [] when there is no ## Verification section", () => {
    const body = `
# My Ticket

## Steps
Do things.

\`\`\`bash
echo no verification section
\`\`\`
`;
    const blocks = extractVerificationBlocks(body);
    expect(blocks).toEqual([]);
  });

  it("does NOT return bash blocks that are outside the ## Verification section", () => {
    const body = `
# My Ticket

## Steps
\`\`\`bash
echo this is NOT in verification
\`\`\`

## Verification

\`\`\`bash
echo this IS in verification
\`\`\`

## Notes
\`\`\`bash
echo this is also NOT in verification
\`\`\`
`;
    const blocks = extractVerificationBlocks(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("this IS in verification");
    expect(blocks[0]).not.toContain("NOT in verification");
  });

  it("returns multiple blocks when multiple bash fences are in ## Verification", () => {
    const body = `
## Verification

\`\`\`bash
echo block1
\`\`\`

\`\`\`bash
echo block2
\`\`\`
`;
    const blocks = extractVerificationBlocks(body);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("block1");
    expect(blocks[1]).toContain("block2");
  });
});

// ---------------------------------------------------------------------------
// runSpecVerification
// ---------------------------------------------------------------------------

describe("runSpecVerification", () => {
  it("returns skippedReason when verifyEnabled=false", async () => {
    const cfg = makeCfg({ verifyEnabled: false });
    const ticket = makeTicket(`
## Verification
\`\`\`bash
true
\`\`\`
`);
    const result = await runSpecVerification(cfg, ticket, wtPath);
    expect(result.skippedReason).toBe("cfg.verify_enabled=false");
    expect(result.blocksRun).toBe(0);
    expect(result.blocksPassed).toBe(0);
  });

  it("returns skippedReason when no ## Verification block", async () => {
    const cfg = makeCfg();
    const ticket = makeTicket("# Just a title\n\nNo verification here.");
    const result = await runSpecVerification(cfg, ticket, wtPath);
    expect(result.skippedReason).toBe("no `## Verification` block in ticket");
    expect(result.blocksRun).toBe(0);
    expect(result.blocksPassed).toBe(0);
  });

  it("passes a single passing block", async () => {
    const cfg = makeCfg();
    // Create a file in the worktree so `test -f` passes
    writeFileSync(join(wtPath, "sentinel.txt"), "ok");
    const ticket = makeTicket(`
## Verification
\`\`\`bash
test -f sentinel.txt
\`\`\`
`);
    const result = await runSpecVerification(cfg, ticket, wtPath);
    expect(result.blocksRun).toBe(1);
    expect(result.blocksPassed).toBe(1);
    expect(result.failedOutputs).toHaveLength(0);
    expect(result.skippedReason).toBeNull();
  });

  it("fails a single failing block", async () => {
    const cfg = makeCfg();
    const ticket = makeTicket(`
## Verification
\`\`\`bash
false
\`\`\`
`);
    const result = await runSpecVerification(cfg, ticket, wtPath);
    expect(result.blocksRun).toBe(1);
    expect(result.blocksPassed).toBe(0);
    expect(result.failedOutputs).toHaveLength(1);
    expect(result.failedOutputs[0].exitCode).not.toBe(0);
    expect(result.skippedReason).toBeNull();
  });

  it("handles two blocks: one pass, one fail", async () => {
    const cfg = makeCfg();
    writeFileSync(join(wtPath, "present.txt"), "yes");
    const ticket = makeTicket(`
## Verification
\`\`\`bash
test -f present.txt
\`\`\`

\`\`\`bash
test -f /nonexistent-file-definitely-absent
\`\`\`
`);
    const result = await runSpecVerification(cfg, ticket, wtPath);
    expect(result.blocksRun).toBe(2);
    expect(result.blocksPassed).toBe(1);
    expect(result.failedOutputs).toHaveLength(1);
    expect(result.failedOutputs[0].exitCode).not.toBe(0);
  });

  it("captures stdout+stderr in the failure entry", async () => {
    const cfg = makeCfg();
    const ticket = makeTicket(`
## Verification
\`\`\`bash
echo "some stdout"
echo "some stderr" >&2
exit 1
\`\`\`
`);
    const result = await runSpecVerification(cfg, ticket, wtPath);
    expect(result.blocksRun).toBe(1);
    expect(result.blocksPassed).toBe(0);
    expect(result.failedOutputs).toHaveLength(1);
    expect(result.failedOutputs[0].output).toContain("some stdout");
    expect(result.failedOutputs[0].output).toContain("some stderr");
    expect(result.failedOutputs[0].exitCode).toBe(1);
  });

  it("includes a preview (first line, max 80 chars) in failure entry", async () => {
    const cfg = makeCfg();
    const ticket = makeTicket(`
## Verification
\`\`\`bash
false
\`\`\`
`);
    const result = await runSpecVerification(cfg, ticket, wtPath);
    expect(result.failedOutputs).toHaveLength(1);
    expect(result.failedOutputs[0].preview).toBe("false");
  });

  it("truncates output to 1500 chars", async () => {
    const cfg = makeCfg();
    // Generate a lot of output (> 1500 chars)
    const ticket = makeTicket(`
## Verification
\`\`\`bash
python3 -c "print('x' * 5000)"
exit 1
\`\`\`
`);
    const result = await runSpecVerification(cfg, ticket, wtPath);
    expect(result.blocksRun).toBe(1);
    expect(result.blocksPassed).toBe(0);
    const output = result.failedOutputs[0].output;
    expect(output.length).toBeLessThanOrEqual(1500);
  });
});

// ---------------------------------------------------------------------------
// Hardening rails (#35): block cap, aggregate deadline, env allowlist
// ---------------------------------------------------------------------------

/** Ticket with `n` verification blocks, each one line of `body` (default `true`). */
function makeTicketWithBlocks(n: number, blockBody = "true"): Ticket {
  const fences = Array.from({ length: n }, () => `\`\`\`bash\n${blockBody}\n\`\`\``).join("\n\n");
  return makeTicket(`## Verification\n\n${fences}\n`);
}

describe("runSpecVerification — block cap", () => {
  it("executes at most MAX_VERIFICATION_BLOCKS and reports the rest as skipped failures", async () => {
    const cfg = makeCfg();
    const total = MAX_VERIFICATION_BLOCKS + 2;
    const runBlockFn = vi.fn(async () => ({ exitCode: 0, output: "" }));
    const result = await runSpecVerification(cfg, makeTicketWithBlocks(total), wtPath, {
      runBlockFn,
    });
    expect(runBlockFn).toHaveBeenCalledTimes(MAX_VERIFICATION_BLOCKS);
    expect(result.blocksRun).toBe(total);
    expect(result.blocksPassed).toBe(MAX_VERIFICATION_BLOCKS);
    expect(result.failedOutputs).toHaveLength(2);
    for (const f of result.failedOutputs) {
      expect(f.exitCode).toBe(-3);
      expect(f.output).toContain("block cap");
    }
  });
});

describe("runSpecVerification — aggregate deadline", () => {
  it("skips remaining blocks once the aggregate wall-clock deadline is exhausted", async () => {
    // 3 blocks × 700s per-block would be 2100s; the hard cap bounds the
    // aggregate at VERIFICATION_MAX_TOTAL_MS. The fake block burns past it.
    const cfg = makeCfg({ verifyCommandTimeout: 700 });
    let fakeNow = 0;
    const runBlockFn = vi.fn(async () => {
      fakeNow += VERIFICATION_MAX_TOTAL_MS + 1;
      return { exitCode: 0, output: "" };
    });
    const result = await runSpecVerification(cfg, makeTicketWithBlocks(3), wtPath, {
      runBlockFn,
      nowFn: () => fakeNow,
    });
    expect(runBlockFn).toHaveBeenCalledTimes(1);
    expect(result.blocksRun).toBe(3);
    expect(result.blocksPassed).toBe(1);
    expect(result.failedOutputs).toHaveLength(2);
    for (const f of result.failedOutputs) {
      expect(f.exitCode).toBe(-3);
      expect(f.output).toContain("deadline");
    }
  });

  it("caps each block's timeout at the remaining aggregate budget", async () => {
    // 2 blocks × 100s → aggregate 200s. Block 1 burns 150s, so block 2 must
    // get only the remaining 50s, not the full per-block 100s.
    const cfg = makeCfg({ verifyCommandTimeout: 100 });
    let fakeNow = 0;
    const timeouts: number[] = [];
    const runBlockFn = vi.fn(async (_b: string, _w: string, timeoutMs: number) => {
      timeouts.push(timeoutMs);
      fakeNow += 150_000;
      return { exitCode: 0, output: "" };
    });
    await runSpecVerification(cfg, makeTicketWithBlocks(2), wtPath, {
      runBlockFn,
      nowFn: () => fakeNow,
    });
    expect(timeouts).toEqual([100_000, 50_000]);
  });
});

describe("runSpecVerification — environment allowlist", () => {
  const SAVED: Record<string, string | undefined> = {};
  const KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "LC_ALL"] as const;

  beforeEach(() => {
    for (const k of KEYS) SAVED[k] = process.env[k];
    process.env.GH_TOKEN = "gho_secret-gh-token";
    process.env.GITHUB_TOKEN = "ghp_secret-github-token";
    process.env.OPENAI_API_KEY = "sk-secret-api-key";
    process.env.LC_ALL = "C";
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
  });

  it("does not expose GH_TOKEN/GITHUB_TOKEN/API keys to verification blocks", async () => {
    const cfg = makeCfg();
    const ticket = makeTicket(`
## Verification
\`\`\`bash
echo "gh=\${GH_TOKEN:-ABSENT} github=\${GITHUB_TOKEN:-ABSENT} api=\${OPENAI_API_KEY:-ABSENT}"
exit 1
\`\`\`
`);
    const result = await runSpecVerification(cfg, ticket, wtPath);
    expect(result.failedOutputs).toHaveLength(1);
    const out = result.failedOutputs[0].output;
    expect(out).toContain("gh=ABSENT");
    expect(out).toContain("github=ABSENT");
    expect(out).toContain("api=ABSENT");
    expect(out).not.toContain("secret");
  });

  it("keeps PATH/HOME/LC_* available to verification blocks", async () => {
    const cfg = makeCfg();
    const ticket = makeTicket(`
## Verification
\`\`\`bash
test -n "$PATH" && test -n "$HOME" && test "$LC_ALL" = "C"
\`\`\`
`);
    const result = await runSpecVerification(cfg, ticket, wtPath);
    expect(result.blocksPassed).toBe(1);
    expect(result.failedOutputs).toHaveLength(0);
  });
});
