import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runOutboxCommand } from "../src/outboxCmd.js";
import {
  outboxPaths,
  enqueueOp,
  MAX_OP_ATTEMPTS,
  FLUSH_LOCK_FILENAME,
  type OutboxOp,
} from "../src/githubOutbox.js";
import { GitOpError } from "../src/git.js";
import type { Config } from "../src/types.js";

function cfgAt(root: string): Config {
  return { stateDir: root, github: { triggerLabel: "junco" } } as unknown as Config;
}

const LABELS: Extract<OutboxOp, { kind: "labels" }> = {
  kind: "labels",
  nwo: "a/b",
  issue: 7,
  add: ["junco:approved"],
  remove: [],
};

/** Write a StoredOp file directly (bypassing enqueueOp) so attempts/lastError
 * can be pinned without burning real flush cycles. */
function writeOp(
  cfg: Config,
  id: string,
  fields: {
    createdAt: string;
    origin: "dashboard" | "reporter" | "prflow" | "assess";
    issueKey: string | null;
    attempts: number;
    lastError: string | null;
    op: unknown;
  },
): void {
  const { dir } = outboxPaths(cfg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(fields), "utf8");
}

const NET_ERR = new GitOpError("gh failed", "connect: network is unreachable", 1);
const PERM_ERR = new GitOpError("gh failed", "HTTP 404: Not Found", 1);

/** Scriptable gh/git fakes, mirroring tests/githubOutbox.test.ts. */
function fakes(handler: (tool: "gh" | "git", args: string[]) => { stdout?: string } | void) {
  const calls: { tool: string; args: string[] }[] = [];
  const ghFn = (async (_cfg: unknown, args: string[]) => {
    calls.push({ tool: "gh", args });
    return { code: 0, stdout: "", stderr: "", ...(handler("gh", args) ?? {}) };
  }) as never;
  const gitFn = (async (_cfg: unknown, args: string[]) => {
    calls.push({ tool: "git", args });
    return { code: 0, stdout: "", stderr: "", ...(handler("git", args) ?? {}) };
  }) as never;
  return { calls, ghFn, gitFn };
}

describe("runOutboxCommand — list", () => {
  it("totally empty → 'outbox empty', exit 0", async () => {
    const cfg = cfgAt(join(tmpdir(), "junco-obxcmd-empty-nonexistent-xyz"));
    const out: string[] = [];
    const code = await runOutboxCommand(cfg, [], { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join("")).toBe("outbox empty\n");
  });

  it("no live ops but dead-letters present → 'outbox empty' + dead footer", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxcmd-deadonly-"));
    const cfg = cfgAt(root);
    const { dead } = outboxPaths(cfg);
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "a.json"), "{}", "utf8");
    writeFileSync(join(dead, "b.json"), "{}", "utf8");
    const out: string[] = [];
    const code = await runOutboxCommand(cfg, [], { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join("")).toBe("outbox empty\ndead: 2\n");
  });

  it("lists queued ops: age, kind, issueKey (falls back to branch), attempts", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxcmd-list-"));
    const cfg = cfgAt(root);
    const t0 = new Date("2026-07-07T10:00:00Z");
    enqueueOp(cfg, "dashboard", { ...LABELS }, { nowFn: () => t0 });
    enqueueOp(
      cfg,
      "prflow",
      { kind: "push", repoPath: "/r", branch: "junco/x" },
      { nowFn: () => t0 },
    );
    const now = new Date("2026-07-07T10:05:00Z"); // +5m
    const out: string[] = [];
    const code = await runOutboxCommand(cfg, [], { printFn: (s) => out.push(s), nowFn: () => now });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/5m ago labels a\/b#7 attempts=0/);
    expect(text).toMatch(/5m ago push junco\/x attempts=0/);
    expect(text).not.toMatch(/dead:/); // no dead-letters → footer omitted
  });

  it("shows lastError when present", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxcmd-lasterr-"));
    const cfg = cfgAt(root);
    writeOp(cfg, "1-0000-aaaa-labels", {
      createdAt: "2026-07-07T10:00:00Z",
      origin: "dashboard",
      issueKey: "a/b#7",
      attempts: 2,
      lastError: "HTTP 404: Not Found",
      op: { ...LABELS },
    });
    const out: string[] = [];
    const code = await runOutboxCommand(cfg, [], {
      printFn: (s) => out.push(s),
      nowFn: () => new Date("2026-07-07T10:00:30Z"),
    });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/attempts=2 lastError=HTTP 404: Not Found/);
  });

  it("malformed op (no op field) renders as <malformed>, list exits 0 (no crash)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxcmd-malformed-"));
    const cfg = cfgAt(root);
    const { dir } = outboxPaths(cfg);
    mkdirSync(dir, { recursive: true });
    // Hand-written op file missing the `op` field entirely.
    writeFileSync(join(dir, "1-0000-bogus.json"), JSON.stringify({ id: "x" }), "utf8");
    const out: string[] = [];
    const code = await runOutboxCommand(cfg, [], { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/<malformed>/);
  });

  it("issue-create op renders a line with the nwo and the fingerprint (no live issue/branch to key by)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxcmd-issuecreate-"));
    const cfg = cfgAt(root);
    writeOp(cfg, "1-0000-aaaa-issue-create", {
      createdAt: "2026-07-07T10:00:00Z",
      origin: "assess",
      issueKey: null,
      attempts: 0,
      lastError: null,
      op: {
        kind: "issue-create",
        nwo: "a/b",
        title: "[high] Vulnerable lodash (GHSA-xxxx-yyyy-zzzz)",
        bodyText: "body text\n\n<!-- junco:finding:deadbeefcafebabe -->",
        labels: ["junco:finding", "severity/high"],
        fingerprint: "deadbeefcafebabe",
      },
    });
    const out: string[] = [];
    const code = await runOutboxCommand(cfg, [], {
      printFn: (s) => out.push(s),
      nowFn: () => new Date("2026-07-07T10:00:30Z"),
    });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/issue-create a\/b deadbeefcafebabe attempts=0/);
  });

  it("op lines + dead footer when both present", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxcmd-both-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    const { dead } = outboxPaths(cfg);
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "x.json"), "{}", "utf8");
    writeFileSync(join(dead, "y.json"), "{}", "utf8");
    writeFileSync(join(dead, "z.json"), "{}", "utf8");
    const out: string[] = [];
    const code = await runOutboxCommand(cfg, [], { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/labels a\/b#7 attempts=0/);
    expect(text).toMatch(/dead: 3\n$/);
  });
});

describe("runOutboxCommand — flush", () => {
  it("clean flush: sent/dead/remaining line, exit 0, no offline line", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxcmd-flush1-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    enqueueOp(cfg, "dashboard", { ...LABELS, issue: 8 });
    const f = fakes(() => undefined);
    const out: string[] = [];
    const code = await runOutboxCommand(cfg, ["flush"], {
      printFn: (s) => out.push(s),
      ghFn: f.ghFn,
      gitFn: f.gitFn,
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/sent 2 · dead 0 · remaining 0/);
    expect(text).not.toMatch(/offline/);
  });

  it("offline flush: exit 0 (expected condition) with the will-retry line", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxcmd-flush2-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    const f = fakes(() => {
      throw NET_ERR;
    });
    const out: string[] = [];
    const code = await runOutboxCommand(cfg, ["flush"], {
      printFn: (s) => out.push(s),
      ghFn: f.ghFn,
      gitFn: f.gitFn,
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/sent 0 · dead 0 · remaining 1/);
    expect(text).toMatch(/offline — will retry when GitHub is reachable/);
  });

  it("flush that dead-letters an op → exit 1", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxcmd-flush3-"));
    const cfg = cfgAt(root);
    // One attempt short of dead-lettering — this flush tips it over.
    writeOp(cfg, "1-0000-perm-labels", {
      createdAt: "2026-07-07T10:00:00Z",
      origin: "dashboard",
      issueKey: "a/b#7",
      attempts: MAX_OP_ATTEMPTS - 1,
      lastError: "HTTP 404: Not Found",
      op: { ...LABELS },
    });
    const f = fakes(() => {
      throw PERM_ERR;
    });
    const out: string[] = [];
    const code = await runOutboxCommand(cfg, ["flush"], {
      printFn: (s) => out.push(s),
      ghFn: f.ghFn,
      gitFn: f.gitFn,
    });
    expect(code).toBe(1);
    expect(out.join("")).toMatch(/sent 0 · dead 1 · remaining 0/);
    expect(readdirSync(outboxPaths(cfg).dead)).toHaveLength(1);
  });

  it("dead-letter + offline in the same pass → exit 1 (dead wins over the offline exit-0 rule)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxcmd-flush4-"));
    const cfg = cfgAt(root);
    // op0 (sorts first): one attempt short — this flush dead-letters it.
    writeOp(cfg, "1-0000-perm-labels", {
      createdAt: "2026-07-07T10:00:00Z",
      origin: "dashboard",
      issueKey: "a/b#7",
      attempts: MAX_OP_ATTEMPTS - 1,
      lastError: "HTTP 404: Not Found",
      op: { ...LABELS },
    });
    enqueueOp(cfg, "dashboard", { ...LABELS, issue: 8 }); // op1 — hits the network
    const f = fakes((_tool, args) => {
      if (args.includes("8")) throw NET_ERR;
      throw PERM_ERR;
    });
    const out: string[] = [];
    const code = await runOutboxCommand(cfg, ["flush"], {
      printFn: (s) => out.push(s),
      ghFn: f.ghFn,
      gitFn: f.gitFn,
    });
    expect(code).toBe(1);
    const text = out.join("");
    expect(text).toMatch(/sent 0 · dead 1 · remaining 1/);
    expect(text).toMatch(/offline — will retry when GitHub is reachable/);
  });

  it("flush while another live flusher holds the lock → clean in-progress line, exit 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxcmd-flush-lock-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    // Our own pid is definitionally alive — reads as a concurrent live flusher.
    writeFileSync(join(outboxPaths(cfg).dir, FLUSH_LOCK_FILENAME), `${process.pid}\n`, "utf8");
    const f = fakes(() => undefined);
    const out: string[] = [];
    const code = await runOutboxCommand(cfg, ["flush"], {
      printFn: (s) => out.push(s),
      ghFn: f.ghFn,
      gitFn: f.gitFn,
    });
    expect(code).toBe(0);
    expect(out.join("")).toBe("another flush is already in progress — skipped\n");
    expect(f.calls).toHaveLength(0);
  });

  it("unexpected flushOutbox throw → one clean failure line + exit 1 (no raw fatal)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxcmd-flush5-"));
    const cfg = cfgAt(root);
    // Dead-letter path with a NON-ENOENT rename failure (e.g. EACCES) — the
    // one class flushOutbox still propagates by design.
    writeOp(cfg, "1-0000-perm-labels", {
      createdAt: "2026-07-07T10:00:00Z",
      origin: "dashboard",
      issueKey: "a/b#7",
      attempts: MAX_OP_ATTEMPTS - 1,
      lastError: "HTTP 404: Not Found",
      op: { ...LABELS },
    });
    const f = fakes(() => {
      throw PERM_ERR;
    });
    const out: string[] = [];
    const code = await runOutboxCommand(cfg, ["flush"], {
      printFn: (s) => out.push(s),
      ghFn: f.ghFn,
      gitFn: f.gitFn,
      renameFn: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    expect(code).toBe(1);
    expect(out.join("")).toBe("outbox flush failed: EACCES: permission denied\n");
  });
});
