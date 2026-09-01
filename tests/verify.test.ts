import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractVerificationBlocks,
  runSpecVerification,
  makeSandboxedRunBlock,
  makeLazySandboxedRunBlock,
  MAX_VERIFICATION_BLOCKS,
  VERIFICATION_MAX_TOTAL_MS,
  type VerifySandbox,
} from "../src/verify.js";
import { noneBackend, type SandboxBackend } from "../src/agent/sandbox/backend.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";
import type { Config, Ticket } from "../src/types.js";
import { makeConfig } from "./helpers/config.js";

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

function makeCfg(overrides: Partial<Config> = {}): Config {
  return makeConfig(
    {
      dataDir: "/tmp/vault/state",
      queueRoot: "/tmp/vault/Junco",
      worktreeRoot: "/tmp/worktrees",
      tools: [],
      criticEnabled: true,
      planLintEnabled: true,
      verifyEnabled: true,
      supervisorEnabled: false,
      healthEnabled: false,
      removeWorktreeOnSuccess: true,
    },
    {
      verifyCommandTimeout: 10, // short so per-command timeout paths are reachable in-test
      planLintBlockOnError: true,
      planLintCheckLabels: true,
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
      botAccount: { enabled: false, configDir: "/tmp/junco-gh" },
      ...overrides,
    },
  );
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
    githubRequest: null,
    assess: null,
    analyze: null,
    workdir: null,
    network: null,
    dependsOn: [],
    depsSatisfied: [],
    plan: null,
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

// ---------------------------------------------------------------------------
// Sandbox routing (#335): blocks execute whatever the agent left in the
// worktree, so they run under the ticket's own sandbox backend + policy.
// ---------------------------------------------------------------------------

/** Synthetic policy — /sbxroot paths so canonicalization is a no-op. */
const POLICY: SandboxPolicy = {
  writableRoots: ["/sbxroot/wt", "/sbxroot/scratch"],
  readDenyPaths: ["/sbxroot/home/.ssh"],
  readDenyFiles: [],
  readAllowPaths: [],
  network: false,
  scratchDir: "/sbxroot/scratch",
  bashTimeoutMs: undefined,
};

/** A backend that records every (command, policy) it is asked to wrap and
 *  returns a runnable argv — by default the command itself under /bin/sh so
 *  the block really executes; `argvFor` overrides what actually runs. */
function recordingBackend(argvFor?: (command: string) => string[]): SandboxBackend & {
  calls: Array<{ command: string; policy: SandboxPolicy }>;
} {
  const calls: Array<{ command: string; policy: SandboxPolicy }> = [];
  return {
    name: "none",
    calls,
    spawnArgv(command, policy) {
      calls.push({ command, policy });
      return argvFor ? argvFor(command) : ["/bin/sh", "-c", command];
    },
    async checkAvailability() {
      return { available: true };
    },
  };
}

/** A fake child process the fake spawn returns; drive it in the test. */
function fakeProc() {
  const proc = new EventEmitter() as any;
  proc.pid = 4242;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

describe("makeSandboxedRunBlock (#335)", () => {
  it("spawns exactly the backend's argv in the worktree with a scrubbed env + TMPDIR=scratch", async () => {
    const proc = fakeProc();
    const spawnFn = vi.fn(() => proc) as any;
    const backend = recordingBackend((c) => ["fake-sandbox", "--confine", "/bin/bash", "-c", c]);
    const run = makeSandboxedRunBlock(backend, POLICY, {
      spawnFn,
      env: () => ({ PATH: "/usr/bin", HOME: "/h", GH_TOKEN: "leak", TMPDIR: "/host/tmp" }),
    });
    const p = run("npm test", "/sbxroot/wt", 5_000);
    proc.stdout.emit("data", Buffer.from("ok\n"));
    proc.emit("close", 0);
    const res = await p;

    expect(res).toEqual({ exitCode: 0, output: "ok\n" });
    expect(backend.calls).toEqual([{ command: "npm test", policy: POLICY }]);
    const [bin, args, opts] = spawnFn.mock.calls[0];
    expect(bin).toBe("fake-sandbox");
    expect(args).toEqual(["--confine", "/bin/bash", "-c", "npm test"]);
    expect(opts.cwd).toBe("/sbxroot/wt");
    expect(opts.env.GH_TOKEN).toBeUndefined();
    expect(opts.env.PATH).toBe("/usr/bin");
    expect(opts.env.TMPDIR).toBe("/sbxroot/scratch");
  });

  it("the none backend produces the direct argv (/bin/bash -c <block>) — unchanged behavior", async () => {
    const proc = fakeProc();
    const spawnFn = vi.fn(() => proc) as any;
    const run = makeSandboxedRunBlock(noneBackend, POLICY, { spawnFn, env: () => ({}) });
    const p = run("true", "/sbxroot/wt", 5_000);
    proc.emit("close", 0);
    await p;
    const [bin, args] = spawnFn.mock.calls[0];
    expect(bin).toBe("/bin/bash");
    expect(args).toEqual(["-c", "true"]);
  });

  it("really executes the block under a live backend argv and captures stdout+stderr", async () => {
    const backend = recordingBackend();
    const run = makeSandboxedRunBlock(backend, POLICY, {
      env: () => ({ PATH: process.env.PATH, HOME: "/h", GH_TOKEN: "leak" }),
    });
    const res = await run(
      'echo "tmp=$TMPDIR gh=${GH_TOKEN:-ABSENT}"; echo err >&2; exit 3',
      wtPath,
      5_000,
    );
    expect(res.exitCode).toBe(3);
    expect(res.output).toContain("tmp=/sbxroot/scratch");
    expect(res.output).toContain("gh=ABSENT");
    expect(res.output).toContain("err");
  });

  it("kills a sandboxed block that overruns its timeout and reports exitCode -1", async () => {
    const run = makeSandboxedRunBlock(recordingBackend(), POLICY);
    const res = await run("sleep 5", wtPath, 100);
    expect(res.exitCode).toBe(-1);
    expect(res.output).toContain("timed out");
  });
});

describe("makeLazySandboxedRunBlock (#335)", () => {
  it("resolves the sandbox on the first block — never at construction — and once across blocks", async () => {
    const backend = recordingBackend();
    const resolve = vi.fn(async () => ({ backend, policy: POLICY }));
    const run = makeLazySandboxedRunBlock(resolve);
    expect(resolve).not.toHaveBeenCalled();
    await run("true", wtPath, 5_000);
    await run("false", wtPath, 5_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(backend.calls.map((c) => c.command)).toEqual(["true", "false"]);
    for (const c of backend.calls) expect(c.policy).toBe(POLICY);
  });

  it("a disabled sandbox (resolver → null) falls back to the direct /bin/bash -c spawn", async () => {
    writeFileSync(join(wtPath, "sentinel.txt"), "ok");
    const run = makeLazySandboxedRunBlock(async () => null);
    // `[[` is bash-only: a pass proves the block ran under bash, in the worktree.
    const res = await run("[[ -f sentinel.txt ]]", wtPath, 5_000);
    expect(res).toEqual({ exitCode: 0, output: "" });
  });

  it("a resolver rejection is memoized and rejects every block — nothing spawns", async () => {
    const spawnFn = vi.fn() as any;
    const resolve = vi.fn(async (): Promise<VerifySandbox | null> => {
      throw new Error('sandbox backend "bwrap" unavailable');
    });
    const run = makeLazySandboxedRunBlock(resolve, { spawnFn });
    await expect(run("true", wtPath, 5_000)).rejects.toThrow('sandbox backend "bwrap" unavailable');
    await expect(run("true", wtPath, 5_000)).rejects.toThrow('sandbox backend "bwrap" unavailable');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe("runSpecVerification — sandbox routing (#335)", () => {
  /** What prFlow threads through `runBlockFn` while verify.sandboxed is on. */
  const sandboxedDeps = (resolve: () => Promise<VerifySandbox | null>) => ({
    runBlockFn: makeLazySandboxedRunBlock(resolve),
  });

  it("routes every block through backend.spawnArgv with the ticket policy", async () => {
    const cfg = makeCfg();
    const backend = recordingBackend();
    const ticket = makeTicket(`
## Verification
\`\`\`bash
true
\`\`\`

\`\`\`bash
false
\`\`\`
`);
    const result = await runSpecVerification(
      cfg,
      ticket,
      wtPath,
      sandboxedDeps(async () => ({ backend, policy: POLICY })),
    );
    expect(backend.calls.map((c) => c.command)).toEqual(["true", "false"]);
    for (const c of backend.calls) expect(c.policy).toBe(POLICY);
    expect(result.blocksRun).toBe(2);
    expect(result.blocksPassed).toBe(1);
    expect(result.failedOutputs).toHaveLength(1);
  });

  it("the backend's argv is what runs — a confining backend decides the block's fate", async () => {
    const cfg = makeCfg();
    // A backend that refuses the block outright (what a deny-all profile does).
    const backend = recordingBackend(() => ["/bin/sh", "-c", "echo denied >&2; exit 77"]);
    const result = await runSpecVerification(
      cfg,
      makeTicketWithBlocks(1),
      wtPath,
      sandboxedDeps(async () => ({ backend, policy: POLICY })),
    );
    expect(result.blocksPassed).toBe(0);
    expect(result.failedOutputs).toEqual([
      { preview: "true", exitCode: 77, output: expect.stringContaining("denied") },
    ]);
  });

  it("resolves the sandbox lazily — never for a block-less ticket or with verify disabled", async () => {
    const resolve = vi.fn(async () => ({ backend: recordingBackend(), policy: POLICY }));
    await runSpecVerification(makeCfg(), makeTicket("# no blocks"), wtPath, sandboxedDeps(resolve));
    await runSpecVerification(
      makeCfg({ verifyEnabled: false }),
      makeTicketWithBlocks(1),
      wtPath,
      sandboxedDeps(resolve),
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolves the sandbox once per ticket — a re-verification reuses the same runner", async () => {
    const backend = recordingBackend();
    const resolve = vi.fn(async () => ({ backend, policy: POLICY }));
    const deps = sandboxedDeps(resolve);
    await runSpecVerification(makeCfg(), makeTicketWithBlocks(2), wtPath, deps);
    await runSpecVerification(makeCfg(), makeTicketWithBlocks(1), wtPath, deps);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(backend.calls).toHaveLength(3);
  });

  it("fails closed when the sandbox cannot be resolved: nothing spawns, every block is a harness failure", async () => {
    const cfg = makeCfg();
    const result = await runSpecVerification(
      cfg,
      makeTicketWithBlocks(2),
      wtPath,
      sandboxedDeps(async () => {
        throw new Error('sandbox backend "bwrap" unavailable');
      }),
    );
    expect(result.blocksRun).toBe(2);
    expect(result.blocksPassed).toBe(0);
    expect(result.skippedReason).toBeNull();
    expect(result.failedOutputs).toHaveLength(2);
    for (const f of result.failedOutputs) {
      expect(f.exitCode).toBe(-2);
      expect(f.output).toContain("verification harness error");
      expect(f.output).toContain('sandbox backend "bwrap" unavailable');
    }
  });
});
