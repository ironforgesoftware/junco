/**
 * Tests for src/submitCmd.ts — `runSubmitCommand(args, opts, deps)` called
 * DIRECTLY, without cli.ts's argv parsing in the way.
 *
 * cli.test.ts pins the same routing through `run(['submit', ...])`; these pin
 * it at the module's own boundary. The one invariant that only shows up here is
 * the CONFIG LOAD ORDER: every usage error must be reported before `loadCfg`
 * runs, so `junco submit` with a broken config still says "usage", not
 * "unparseable config".
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/types.js";
import { makeConfig, READ_ONLY_TOOLS } from "./helpers/config.js";
import { runSubmitCommand } from "../src/submitCmd.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshQueue(): { cfg: Config; root: string; inbox: string } {
  const root = mkdtempSync(join(tmpdir(), "junco-submitcmd-"));
  tmpDirs.push(root);
  const cfg = makeConfig({
    dataDir: root,
    queueRoot: join(root, "queue"),
    worktreeRoot: join(root, "worktrees"),
    tools: READ_ONLY_TOOLS,
    criticEnabled: false,
    planLintEnabled: false,
    verifyEnabled: false,
    supervisorEnabled: false,
    healthEnabled: false,
    removeWorktreeOnSuccess: false,
  });
  return { cfg, root, inbox: join(root, "queue", "inbox") };
}

/** stderr capture that survives mockRestore()'s internal reset. */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
    lines.push(String(s));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe("runSubmitCommand — usage errors never load the config", () => {
  it("no file argument: exit 2, loadCfg untouched", async () => {
    const loadCfg = vi.fn<() => Config>();
    const err = captureStderr();
    let code: number;
    try {
      code = await runSubmitCommand([], {}, { loadCfg });
    } finally {
      err.restore();
    }
    expect(code).toBe(2);
    expect(loadCfg).not.toHaveBeenCalled();
    expect(err.lines.join("")).toContain("Usage: junco submit <file|->");
  });

  it("--patch together with a positional file: exit 2, loadCfg untouched", async () => {
    const loadCfg = vi.fn<() => Config>();
    const err = captureStderr();
    let code: number;
    try {
      code = await runSubmitCommand(["t.md"], { patch: "p.patch" }, { loadCfg });
    } finally {
      err.restore();
    }
    expect(code).toBe(2);
    expect(loadCfg).not.toHaveBeenCalled();
    expect(err.lines.join("")).toContain("mutually exclusive");
  });

  it("--patch --plan: exit 2, loadCfg untouched", async () => {
    const loadCfg = vi.fn<() => Config>();
    const err = captureStderr();
    let code: number;
    try {
      code = await runSubmitCommand([], { patch: "p.patch", plan: true }, { loadCfg });
    } finally {
      err.restore();
    }
    expect(code).toBe(2);
    expect(loadCfg).not.toHaveBeenCalled();
  });

  it("--patch without --repo: exit 2, loadCfg untouched", async () => {
    const loadCfg = vi.fn<() => Config>();
    const err = captureStderr();
    let code: number;
    try {
      code = await runSubmitCommand([], { patch: "p.patch" }, { loadCfg });
    } finally {
      err.restore();
    }
    expect(code).toBe(2);
    expect(loadCfg).not.toHaveBeenCalled();
    expect(err.lines.join("")).toContain("Usage: junco submit --patch <file> --repo <path>");
  });
});

describe("runSubmitCommand — local inbox submit", () => {
  it("submits a file ticket, prints the destination, and lands it in the inbox", async () => {
    const { cfg, root, inbox } = freshQueue();
    const file = join(root, "my-ticket.md");
    writeFileSync(file, "---\nid: submitcmd-file\n---\n\n# T\n", "utf8");
    const out: string[] = [];
    const code = await runSubmitCommand(
      [file],
      {},
      { loadCfg: () => cfg, printFn: (s) => out.push(s) },
    );
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/^submitted: /);
    expect(existsSync(join(inbox, "submitcmd-file.md"))).toBe(true);
  });

  it("reads stdin for '-' and warns on a depends_on that resolves nowhere", async () => {
    const { cfg, inbox } = freshQueue();
    const out: string[] = [];
    const err = captureStderr();
    let code: number;
    try {
      code = await runSubmitCommand(
        ["-"],
        {},
        {
          loadCfg: () => cfg,
          printFn: (s) => out.push(s),
          readStdinFn: async () => "---\nid: kid\ndepends_on: [ghost]\n---\n",
        },
      );
    } finally {
      err.restore();
    }
    expect(code).toBe(0);
    expect(existsSync(join(inbox, "kid.md"))).toBe(true);
    expect(err.lines.join("")).toContain(
      "junco submit: warning — depends_on references no queued or finished ticket: ghost",
    );
  });
});

describe("runSubmitCommand — --patch compose door", () => {
  const PATCH = [
    "From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001",
    "From: A <a@example.com>",
    "Date: Mon, 1 Sep 2026 00:00:00 +0000",
    "Subject: [PATCH] tweak",
    "",
    "---",
    " a.txt | 1 +",
    "",
    "diff --git a/a.txt b/a.txt",
    "index 0000000..1111111 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -0,0 +1 @@",
    "+hello",
    "-- ",
    "2.40.0",
    "",
  ].join("\n");

  it("composes an apply ticket from a format-patch file and submits it", async () => {
    const { cfg, root, inbox } = freshQueue();
    const patchFile = join(root, "0001-tweak.patch");
    writeFileSync(patchFile, PATCH, "utf8");
    const out: string[] = [];
    const code = await runSubmitCommand(
      [],
      { patch: patchFile, repo: "/sbxroot/repo", title: "Tweak The File" },
      { loadCfg: () => cfg, printFn: (s) => out.push(s) },
    );
    expect(code).toBe(0);
    const files = readdirSync(inbox).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^Tweak-The-File-\d{4}-\d{2}-\d{2}\.md$/);
    const landed = readFileSync(join(inbox, files[0]), "utf8");
    expect(landed).toContain('pr_title: "Tweak The File"');
    expect(landed).toContain("diff --git a/a.txt b/a.txt");
  });

  it("a file that is not a well-formed series exits 1 and submits nothing", async () => {
    const { cfg, root, inbox } = freshQueue();
    const patchFile = join(root, "not-a-patch.patch");
    writeFileSync(patchFile, "just some text\n", "utf8");
    const err = captureStderr();
    let code: number;
    try {
      code = await runSubmitCommand(
        [],
        { patch: patchFile, repo: "/sbxroot/repo" },
        { loadCfg: () => cfg },
      );
    } finally {
      err.restore();
    }
    expect(code).toBe(1);
    expect(err.lines.join("")).toContain("is not a well-formed");
    expect(existsSync(inbox)).toBe(false);
  });
});

describe("runSubmitCommand — --dry-run routing", () => {
  it("routes to runSubmitDryRunFn with the config, file and content", async () => {
    const { cfg, root } = freshQueue();
    const file = join(root, "t.md");
    writeFileSync(file, "---\nid: dry\n---\n\n# T\n", "utf8");
    const seen: unknown[] = [];
    const code = await runSubmitCommand(
      [file],
      { dryRun: true },
      {
        loadCfg: () => cfg,
        runSubmitDryRunFn: async (c, f, s) => {
          seen.push(c, f, s);
          return 7;
        },
      },
    );
    expect(code).toBe(7);
    expect(seen[1]).toBe(file);
    expect(String(seen[2])).toContain("id: dry");
  });

  it("--dry-run with --plan or stdin is a usage error", async () => {
    const { cfg, root } = freshQueue();
    const file = join(root, "t.md");
    writeFileSync(file, "---\nid: dry\n---\n\n# T\n", "utf8");
    const err = captureStderr();
    try {
      expect(
        await runSubmitCommand([file], { dryRun: true, plan: true }, { loadCfg: () => cfg }),
      ).toBe(2);
      expect(
        await runSubmitCommand(
          ["-"],
          { dryRun: true },
          { loadCfg: () => cfg, readStdinFn: async () => "" },
        ),
      ).toBe(2);
    } finally {
      err.restore();
    }
  });
});
