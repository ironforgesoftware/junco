import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recoverOrphans } from "../src/orphans.js";
import type { Config } from "../src/types.js";
import { makeConfig as baseConfig } from "./helpers/config.js";

const roots: string[] = [];

function makeConfig(): { cfg: Config; root: string } {
  const root = mkdtempSync(join(tmpdir(), "junco-orphans-"));
  roots.push(root);
  // gh is never invoked by recoverOrphans, so ghBin stays at the shared
  // helper's poisoned default (/nonexistent/gh).
  const cfg: Config = baseConfig(
    {
      dataDir: root,
      queueRoot: join(root, "Junco"),
      worktreeRoot: "/tmp/worktrees",
      tools: ["read"],
      criticEnabled: true,
      planLintEnabled: true,
      verifyEnabled: true,
      supervisorEnabled: true,
      healthEnabled: false,
      removeWorktreeOnSuccess: true,
    },
    {
      defaultTimeoutMinutes: 1,
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
    },
  );
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

  it("single orphan with budget remaining: requeued to inbox/ with retry_count+1, no banner", () => {
    const { cfg, root } = makeConfig();
    const processing = join(root, "Junco", "processing");
    const inbox = join(root, "Junco", "inbox");
    mkdirSync(processing, { recursive: true });
    mkdirSync(inbox, { recursive: true });

    const name = "2026-01-01T0000Z__task-a.md";
    const orphanPath = join(processing, name);
    writeFileSync(orphanPath, "---\nid: task-a\n---\n# Task A\nbody\n", "utf8");

    const result = recoverOrphans(cfg);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(join(inbox, "task-a.md")); // claim stamp stripped

    // Gone from processing/, back in inbox/
    expect(existsSync(orphanPath)).toBe(false);
    const text = readFileSync(join(inbox, "task-a.md"), "utf8");
    expect(text).toContain("retry_count: 1");
    expect(text).toContain("not_before:");
    expect(text).not.toContain("## Orphan recovery");
    expect(text).not.toContain("junco-result");
  });

  it("orphan with exhausted budget: moved to failed/ with the banner", () => {
    const { cfg, root } = makeConfig();
    const processing = join(root, "Junco", "processing");
    const failed = join(root, "Junco", "failed");
    mkdirSync(processing, { recursive: true });
    mkdirSync(failed, { recursive: true });

    const name = "2026-01-01T0000Z__task-spent.md";
    writeFileSync(
      join(processing, name),
      "---\nid: task-spent\nretry_count: 2\n---\n# Spent\nbody\n",
      "utf8",
    );

    const result = recoverOrphans(cfg);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(join(failed, name));
    const text = readFileSync(join(failed, name), "utf8");
    expect(text).toContain("## Orphan recovery");
    expect(text).toContain("status: failed");
    expect(text).toContain("Retry budget exhausted");
  });

  it("multiple fresh orphans: all three requeued to inbox/, returns 3 dst paths", () => {
    const { cfg, root } = makeConfig();
    const processing = join(root, "Junco", "processing");
    const inbox = join(root, "Junco", "inbox");
    mkdirSync(processing, { recursive: true });
    mkdirSync(inbox, { recursive: true });

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
      expect(existsSync(join(inbox, n.replace(/^.*__/, "")))).toBe(true);
    }
  });

  it("exhausted-budget orphan does not clobber a same-named failed/ record (issue #48)", () => {
    const { cfg, root } = makeConfig();
    const processing = join(root, "Junco", "processing");
    const failed = join(root, "Junco", "failed");
    mkdirSync(processing, { recursive: true });
    mkdirSync(failed, { recursive: true });

    const name = "2026-01-01T0000Z__task-dup.md";
    // A prior terminal record already sits at the destination name.
    writeFileSync(join(failed, name), "ATTEMPT ONE — must survive", "utf8");
    writeFileSync(
      join(processing, name),
      "---\nid: task-dup\nretry_count: 2\n---\n# Dup\nbody\n",
      "utf8",
    );

    const result = recoverOrphans(cfg);

    expect(result).toHaveLength(1);
    // The pre-existing record is untouched.
    expect(readFileSync(join(failed, name), "utf8")).toBe("ATTEMPT ONE — must survive");
    // The recovered orphan landed at a uniquified name.
    expect(result[0]).not.toBe(join(failed, name));
    expect(readFileSync(result[0], "utf8")).toContain("## Orphan recovery");
    expect(existsSync(join(processing, name))).toBe(false);
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

  it("banner contains injected timestamp string (exhausted-budget path)", () => {
    const { cfg, root } = makeConfig();
    const processing = join(root, "Junco", "processing");
    const failed = join(root, "Junco", "failed");
    mkdirSync(processing, { recursive: true });
    mkdirSync(failed, { recursive: true });

    const name = "2026-01-01T0000Z__task-ts.md";
    writeFileSync(
      join(processing, name),
      "---\nid: task-ts\nretry_count: 2\n---\n# TS task\nbody\n",
      "utf8",
    );

    const fixedNow = "2026-05-31T12:00:00.000Z";
    const result = recoverOrphans(cfg, { now: () => fixedNow });

    expect(result).toHaveLength(1);
    const text = readFileSync(join(failed, name), "utf8");
    expect(text).toContain(fixedNow);
  });

  it("idempotent-ish: second run on empty processing/ returns []", () => {
    const { cfg, root } = makeConfig();
    const processing = join(root, "Junco", "processing");
    mkdirSync(processing, { recursive: true });

    const name = "2026-01-01T0000Z__task-idem.md";
    writeFileSync(join(processing, name), "# Idem\nbody\n", "utf8");

    // First run — requeues the orphan
    const first = recoverOrphans(cfg);
    expect(first).toHaveLength(1);

    // Second run — processing/ is now empty
    const second = recoverOrphans(cfg);
    expect(second).toEqual([]);
  });
});
