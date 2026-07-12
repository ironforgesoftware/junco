/**
 * Tests for src/dispatch.ts — inbox helpers + atomic submit.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  lstatSync,
  linkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/types.js";
import { inboxPath, submitTicket } from "../src/dispatch.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONFIG_DEFAULTS: Omit<Config, "vaultRoot" | "juncoSubdir"> = {
  model: {
    id: "test-model",
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
  tools: ["read", "bash"],
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
  verifyEnabled: false,
  verifyCommandTimeout: 60,
  verifyBlockOnFail: false,
  planLintEnabled: false,
  planLintBlockOnError: false,
  planLintCheckLabels: false,
  commitLeftoversEnabled: false,
  dailyBudgetUsd: 0,
  criticEnabled: false,
  criticMaxRetries: 1,
  criticThinking: "minimal",
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
};

function makeConfig(vaultRoot: string): Config {
  return { ...CONFIG_DEFAULTS, vaultRoot, juncoSubdir: "Junco" };
}

const TICKET_NO_FRONTMATTER = `# Do the thing

Just a plain task with no frontmatter.
`;

const TICKET_WITH_ID = `---
id: my-cool-task
priority: high
---

# Do the thing
`;

const TICKET_MESSY_ID = `---
id: "Hello World! (feat: new)"
---

Some task.
`;

const TICKET_SYMBOL_ONLY_ID = `---
id: "!!!"
---

Symbol task.
`;

// ---------------------------------------------------------------------------
// Setup: temp vault per test
// ---------------------------------------------------------------------------

let tmpVaults: string[] = [];

function freshVault(): { cfg: Config; vaultRoot: string } {
  const vaultRoot = mkdtempSync(join(tmpdir(), "junco-dispatch-"));
  tmpVaults.push(vaultRoot);
  return { cfg: makeConfig(vaultRoot), vaultRoot };
}

afterEach(() => {
  for (const v of tmpVaults) {
    try {
      rmSync(v, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpVaults = [];
});

// ---------------------------------------------------------------------------
// inboxPath
// ---------------------------------------------------------------------------

describe("inboxPath(cfg)", () => {
  it("ends with /inbox", () => {
    const { cfg } = freshVault();
    expect(inboxPath(cfg)).toMatch(/\/inbox$/);
  });

  it("is inside vaultRoot/juncoSubdir", () => {
    const { cfg, vaultRoot } = freshVault();
    expect(inboxPath(cfg)).toBe(join(vaultRoot, "Junco", "inbox"));
  });
});

// ---------------------------------------------------------------------------
// submitTicket — happy paths
// ---------------------------------------------------------------------------

describe("submitTicket", () => {
  it("creates the inbox directory if it does not exist", () => {
    const { cfg, vaultRoot } = freshVault();
    submitTicket(cfg, TICKET_NO_FRONTMATTER, {});
    expect(existsSync(join(vaultRoot, "Junco", "inbox"))).toBe(true);
  });

  it("writes a .md file containing the original content", () => {
    const { cfg } = freshVault();
    const dst = submitTicket(cfg, TICKET_WITH_ID, {});
    const content = readFileSync(dst, "utf8");
    expect(content).toBe(TICKET_WITH_ID);
  });

  it("derives id from frontmatter when present", () => {
    const { cfg } = freshVault();
    const dst = submitTicket(cfg, TICKET_WITH_ID, {});
    expect(dst).toMatch(/my-cool-task\.md$/);
  });

  it("returns the destination path", () => {
    const { cfg, vaultRoot } = freshVault();
    const dst = submitTicket(cfg, TICKET_WITH_ID, {});
    expect(dst).toBe(join(vaultRoot, "Junco", "inbox", "my-cool-task.md"));
  });

  it("uses idHint when ticket has no frontmatter id", () => {
    const { cfg } = freshVault();
    const dst = submitTicket(cfg, TICKET_NO_FRONTMATTER, { idHint: "my-hint" });
    expect(dst).toMatch(/my-hint\.md$/);
  });

  it("uses frontmatter id over idHint when frontmatter id is set", () => {
    const { cfg } = freshVault();
    const dst = submitTicket(cfg, TICKET_WITH_ID, { idHint: "ignored-hint" });
    expect(dst).toMatch(/my-cool-task\.md$/);
  });

  it("no leftover .tmp file remains after successful submit", () => {
    const { cfg, vaultRoot } = freshVault();
    submitTicket(cfg, TICKET_WITH_ID, {});
    const inbox = join(vaultRoot, "Junco", "inbox");
    const entries = readdirSync(inbox);
    const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("the written file has a .md extension (daemon's glob would find it)", () => {
    const { cfg } = freshVault();
    const dst = submitTicket(cfg, TICKET_WITH_ID, {});
    expect(dst).toMatch(/\.md$/);
    expect(existsSync(dst)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// submitTicket — id slugification
// ---------------------------------------------------------------------------

describe("submitTicket — slugification", () => {
  it("slugifies a messy id (spaces, parens, special chars)", () => {
    const { cfg } = freshVault();
    const dst = submitTicket(cfg, TICKET_MESSY_ID, {});
    // Must not contain spaces or special chars
    const filename = dst.split("/").at(-1)!;
    expect(filename).toMatch(/^[A-Za-z0-9._-]+\.md$/);
    // Should contain recognizable parts
    expect(filename).toMatch(/Hello|World|feat|new/);
  });

  it("falls back to 'ticket' when the id is empty or only symbols", () => {
    const { cfg } = freshVault();
    const dst = submitTicket(cfg, TICKET_SYMBOL_ONLY_ID, {});
    expect(dst).toMatch(/ticket\.md$/);
  });
});

// ---------------------------------------------------------------------------
// submitTicket — clobber protection
// ---------------------------------------------------------------------------

describe("submitTicket — clobber protection", () => {
  it("throws 'ticket already queued' when submitting the same id twice", () => {
    const { cfg } = freshVault();
    submitTicket(cfg, TICKET_WITH_ID, {});
    expect(() => submitTicket(cfg, TICKET_WITH_ID, {})).toThrow(/ticket already queued/);
  });

  it("allows submitting two different ids", () => {
    const { cfg } = freshVault();
    const a = `---\nid: task-alpha\n---\nA\n`;
    const b = `---\nid: task-beta\n---\nB\n`;
    expect(() => {
      submitTicket(cfg, a, {});
      submitTicket(cfg, b, {});
    }).not.toThrow();
  });

  it("no-hardlink filesystem: falls back to rename, still lands the ticket (issue #81)", () => {
    const { cfg, vaultRoot } = freshVault();
    const eperm = () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    const dst = submitTicket(cfg, TICKET_WITH_ID, {}, { linkFn: eperm });
    expect(dst).toBe(join(vaultRoot, "Junco", "inbox", "my-cool-task.md"));
    expect(readFileSync(dst, "utf8")).toBe(TICKET_WITH_ID);
    // No leftover temp hardlink.
    const inbox = join(vaultRoot, "Junco", "inbox");
    expect(readdirSync(inbox).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
  });

  it("no-hardlink fallback still reports 'already queued' for a duplicate id (issue #81)", () => {
    const { cfg } = freshVault();
    const enosys = () => {
      throw Object.assign(new Error("ENOSYS"), { code: "ENOSYS" });
    };
    submitTicket(cfg, TICKET_WITH_ID, {}, { linkFn: enosys });
    expect(() => submitTicket(cfg, TICKET_WITH_ID, {}, { linkFn: enosys })).toThrow(
      /already queued/,
    );
  });

  it("an unrelated link error (EACCES) is rethrown, not treated as no-hardlink (issue #81)", () => {
    const { cfg } = freshVault();
    const eacces = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(() => submitTicket(cfg, TICKET_WITH_ID, {}, { linkFn: eacces })).toThrow(/EACCES/);
  });

  it("uses a per-submit unique temp file, not a shared .slug.md.tmp, so concurrent same-slug submits never share an inode (issue #110)", () => {
    const { cfg, vaultRoot } = freshVault();
    const inbox = join(vaultRoot, "Junco", "inbox");
    const tmpBasenames: string[] = [];
    const spy = (existing: string, dest: string) => {
      tmpBasenames.push(existing.split("/").at(-1)!);
      linkSync(existing, dest); // real link; throws EEXIST on the duplicate dest
    };
    submitTicket(cfg, TICKET_WITH_ID, {}, { linkFn: spy });
    expect(() => submitTicket(cfg, TICKET_WITH_ID, {}, { linkFn: spy })).toThrow(/already queued/);

    expect(tmpBasenames).toHaveLength(2);
    // Distinct temp inode per submit — never the old shared `.slug.md.tmp` name.
    expect(tmpBasenames[0]).not.toBe(tmpBasenames[1]);
    expect(tmpBasenames).not.toContain(".my-cool-task.md.tmp");
    // Still hidden + non-.md so the daemon's *.md glob never sees a temp.
    for (const t of tmpBasenames) {
      expect(t.startsWith(".")).toBe(true);
      expect(t.endsWith(".tmp")).toBe(true);
      expect(t.endsWith(".md")).toBe(false);
    }
    // No leftover temp files after both submits.
    expect(readdirSync(inbox).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
  });

  it("no-hardlink fallback claims an exclusive slot (not check-then-act): a held slot blocks a racing submit before dest exists (issue #111)", () => {
    const { cfg, vaultRoot } = freshVault();
    const inbox = join(vaultRoot, "Junco", "inbox");
    mkdirSync(inbox, { recursive: true });
    // Simulate a concurrent no-hardlink submit that has ATOMICALLY claimed the
    // slot but not yet renamed its temp into place: the destination .md does
    // not exist yet, so the old existsSync(destPath) check would say "free" and
    // proceed to rename — a check-then-act race.
    const slot = join(inbox, ".my-cool-task.md.claim");
    writeFileSync(slot, "");
    const destPath = join(inbox, "my-cool-task.md");
    expect(existsSync(destPath)).toBe(false); // the stale check would say "free"

    const enosys = () => {
      throw Object.assign(new Error("ENOSYS"), { code: "ENOSYS" });
    };
    // The exclusive-create slot claim must fail EEXIST → "already queued"
    // instead of check-then-act renaming over the racing winner.
    expect(() => submitTicket(cfg, TICKET_WITH_ID, {}, { linkFn: enosys })).toThrow(
      /already queued/,
    );

    // The winner's held slot is untouched, and the loser placed no ticket .md.
    expect(existsSync(slot)).toBe(true);
    expect(existsSync(destPath)).toBe(false);
    // No leftover temp from the loser.
    expect(readdirSync(inbox).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
  });

  it("atomic placement: does not clobber an occupied slot the existence check can't see (issue #49)", () => {
    const { cfg, vaultRoot } = freshVault();
    const inbox = join(vaultRoot, "Junco", "inbox");
    mkdirSync(inbox, { recursive: true });
    // A dangling symlink is the check-then-act blind spot made deterministic:
    // existsSync(destPath) === false (its target is missing), yet the path is
    // occupied. A bare rename would silently replace it; the atomic linkSync
    // must fail EEXIST and surface the duplicate error instead.
    const destPath = join(inbox, "raced.md");
    symlinkSync(join(inbox, "nonexistent-target"), destPath);
    expect(existsSync(destPath)).toBe(false); // the stale check would say "free"

    expect(() => submitTicket(cfg, `---\nid: raced\n---\nLOSER\n`, {})).toThrow(/already queued/);
    // The occupied slot is untouched — still the original dangling symlink,
    // not clobbered into a regular file.
    expect(lstatSync(destPath).isSymbolicLink()).toBe(true);
    // No leftover temp hardlink.
    expect(readdirSync(inbox).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
  });
});
