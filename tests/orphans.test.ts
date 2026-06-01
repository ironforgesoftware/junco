import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recoverOrphans } from "../src/orphans.js";
import type { Config } from "../src/types.js";

const roots: string[] = [];

function makeConfig(): { cfg: Config; root: string } {
  const root = mkdtempSync(join(tmpdir(), "junco-orphans-"));
  roots.push(root);
  const cfg: Config = {
    vaultRoot: root,
    juncoSubdir: "Junco",
    omlx: { url: "u", apiKey: "k" },
    modelId: "m",
    tools: ["read"],
    defaultTimeoutMinutes: 1,
    pollIntervalSeconds: 15,
    startupPollSeconds: 30,
    startupWait: true,
    supervisorEnabled: true,
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
  };
  return { cfg, root };
}

afterEach(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});

describe("recoverOrphans", () => {
  it("no orphans: empty processing/ returns []", () => {
    const { cfg, root } = makeConfig();
    mkdirSync(join(root, "Junco", "processing"), { recursive: true });
    mkdirSync(join(root, "Junco", "failed"), { recursive: true });
    const result = recoverOrphans(cfg);
    expect(result).toEqual([]);
  });

  it("no orphans: missing processing dir (created by recovery) returns []", () => {
    const { cfg } = makeConfig();
    // processing/ doesn't exist yet — recoverOrphans must create it
    const result = recoverOrphans(cfg);
    expect(result).toEqual([]);
  });

  it("single orphan: moved from processing/ to failed/, content updated", () => {
    const { cfg, root } = makeConfig();
    const processing = join(root, "Junco", "processing");
    const failed = join(root, "Junco", "failed");
    mkdirSync(processing, { recursive: true });
    mkdirSync(failed, { recursive: true });

    const name = "2026-01-01T0000Z__task-a.md";
    const orphanPath = join(processing, name);
    writeFileSync(orphanPath, "---\nid: task-a\n---\n# Task A\nbody\n", "utf8");

    const result = recoverOrphans(cfg);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(join(failed, name));

    // Gone from processing/
    expect(existsSync(orphanPath)).toBe(false);

    // Present in failed/
    expect(existsSync(join(failed, name))).toBe(true);

    const text = readFileSync(join(failed, name), "utf8");
    expect(text).toContain("## Orphan recovery");
    expect(text).toContain("status: failed");
  });

  it("multiple orphans: all three moved to failed/, returns 3 dst paths", () => {
    const { cfg, root } = makeConfig();
    const processing = join(root, "Junco", "processing");
    const failed = join(root, "Junco", "failed");
    mkdirSync(processing, { recursive: true });
    mkdirSync(failed, { recursive: true });

    const names = [
      "2026-01-01T0000Z__task-a.md",
      "2026-01-02T0000Z__task-b.md",
      "2026-01-03T0000Z__task-c.md",
    ];
    for (const n of names) {
      writeFileSync(join(processing, n), `# ${n}\nbody\n`, "utf8");
    }

    const result = recoverOrphans(cfg);
    expect(result).toHaveLength(3);

    for (const n of names) {
      expect(existsSync(join(processing, n))).toBe(false);
      expect(existsSync(join(failed, n))).toBe(true);
    }
  });

  it("non-.md files are ignored and left untouched", () => {
    const { cfg, root } = makeConfig();
    const processing = join(root, "Junco", "processing");
    mkdirSync(processing, { recursive: true });

    const txtPath = join(processing, "notes.txt");
    writeFileSync(txtPath, "some notes", "utf8");

    const result = recoverOrphans(cfg);
    expect(result).toEqual([]);
    expect(existsSync(txtPath)).toBe(true);
  });

  it("banner contains injected timestamp string", () => {
    const { cfg, root } = makeConfig();
    const processing = join(root, "Junco", "processing");
    const failed = join(root, "Junco", "failed");
    mkdirSync(processing, { recursive: true });
    mkdirSync(failed, { recursive: true });

    const name = "2026-01-01T0000Z__task-ts.md";
    writeFileSync(join(processing, name), "# TS task\nbody\n", "utf8");

    const fixedNow = "2026-05-31T12:00:00.000Z";
    const result = recoverOrphans(cfg, { now: () => fixedNow });

    expect(result).toHaveLength(1);
    const text = readFileSync(join(failed, name), "utf8");
    expect(text).toContain(fixedNow);
  });

  it("idempotent-ish: second run on empty processing/ returns []", () => {
    const { cfg, root } = makeConfig();
    const processing = join(root, "Junco", "processing");
    const failed = join(root, "Junco", "failed");
    mkdirSync(processing, { recursive: true });
    mkdirSync(failed, { recursive: true });

    const name = "2026-01-01T0000Z__task-idem.md";
    writeFileSync(join(processing, name), "# Idem\nbody\n", "utf8");

    // First run — moves the orphan
    const first = recoverOrphans(cfg);
    expect(first).toHaveLength(1);

    // Second run — processing/ is now empty
    const second = recoverOrphans(cfg);
    expect(second).toEqual([]);
  });
});
