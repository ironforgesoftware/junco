import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractVerificationBlocks, runSpecVerification } from "../src/verify.js";
import type { Config, Ticket } from "../src/types.js";

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    vaultRoot: "/tmp/vault",
    juncoSubdir: "Junco",
    model: {
      id: "test/model",
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
    assess: { maxIssuesPerRun: 20, minSeverity: "low", npmBin: "npm" },
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
    workdir: null,
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
