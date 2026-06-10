import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stripResultArtifacts, removeFrontmatterKey, runRetryCommand } from "../src/retryCmd.js";
import type { Config } from "../src/types.js";

describe("stripResultArtifacts", () => {
  it("cuts at the FIRST junco-result block (drops all appended artifacts)", () => {
    const c =
      "---\nid: a\n---\nbody\n\n---\n<!-- junco-result\nstatus: failed\n-->\n\n## Result\n…\n\n---\n<!-- junco-result\nstatus: failed\n-->\n";
    expect(stripResultArtifacts(c)).toBe("---\nid: a\n---\nbody\n");
  });
  it("no-op when there is no result block", () => {
    expect(stripResultArtifacts("---\nid: a\n---\nbody\n")).toBe("---\nid: a\n---\nbody\n");
  });
});

describe("removeFrontmatterKey", () => {
  it("removes the key line, leaves the rest", () => {
    expect(removeFrontmatterKey("---\nid: a\nretry_count: 2\n---\nb", "retry_count")).toBe(
      "---\nid: a\n---\nb",
    );
  });
  it("no-op when key or frontmatter is absent", () => {
    expect(removeFrontmatterKey("---\nid: a\n---\nb", "retry_count")).toBe("---\nid: a\n---\nb");
    expect(removeFrontmatterKey("plain body", "retry_count")).toBe("plain body");
  });
});

describe("runRetryCommand", () => {
  let root: string;
  let cfg: Config;
  let out: string[];
  const failedName = "2026-06-10T1200Z__fix-thing.md";
  const failedBody =
    '---\nid: fix-thing\nretry_count: 2\nnot_before: "2026-06-10T13:00:00Z"\n---\nplease fix\n\n---\n<!-- junco-result\nstatus: failed\n-->\n\n## Result\nnope\n';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-retry-"));
    for (const d of ["inbox", "processing", "done", "failed"])
      mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "failed", failedName), failedBody, "utf8");
    cfg = { vaultRoot: root, juncoSubdir: "", defaultTimeoutMinutes: 30 } as unknown as Config;
    out = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("moves a failed ticket back to inbox: stamp stripped, artifacts stripped, retry bookkeeping cleared", async () => {
    const code = await runRetryCommand(cfg, ["fix-thing"], {}, { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    const dst = join(root, "inbox", "fix-thing.md");
    expect(existsSync(dst)).toBe(true);
    expect(existsSync(join(root, "failed", failedName))).toBe(false);
    const content = readFileSync(dst, "utf8");
    expect(content).not.toMatch(/junco-result|retry_count|not_before/);
    expect(content).toMatch(/please fix/);
  });

  it("--all retries everything in failed/", async () => {
    writeFileSync(join(root, "failed", "another.md"), "---\nid: another\n---\nx\n", "utf8");
    const code = await runRetryCommand(cfg, [], { all: true }, { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(readdirSync(join(root, "failed"))).toHaveLength(0);
    expect(readdirSync(join(root, "inbox"))).toHaveLength(2);
  });

  it("ambiguous substring → exit 2, nothing moved; unknown name → exit 1", async () => {
    writeFileSync(join(root, "failed", "fix-thing-2.md"), "x", "utf8");
    expect(await runRetryCommand(cfg, ["fix"], {}, { printFn: (s) => out.push(s) })).toBe(2);
    expect(readdirSync(join(root, "failed"))).toHaveLength(2);
    expect(await runRetryCommand(cfg, ["zzz"], {}, { printFn: (s) => out.push(s) })).toBe(1);
  });

  it("collision with an already-queued ticket reports the error and exits 1", async () => {
    writeFileSync(join(root, "inbox", "fix-thing.md"), "occupied", "utf8");
    const code = await runRetryCommand(cfg, ["fix-thing"], {}, { printFn: (s) => out.push(s) });
    expect(code).toBe(1);
    expect(out.join("")).toMatch(/already queued/);
    // Source preserved on failure.
    expect(existsSync(join(root, "failed", failedName))).toBe(true);
  });

  it("no names and no --all → usage + exit 2", async () => {
    expect(await runRetryCommand(cfg, [], {}, { printFn: (s) => out.push(s) })).toBe(2);
  });
});
