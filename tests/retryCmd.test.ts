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
    cfg = { queueRoot: root, defaultTimeoutMinutes: 30 } as unknown as Config;
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

describe("dependency-cascade resurrection (spec 2026-08-20)", () => {
  let root: string;
  let cfg: Config;
  let inbox: string;
  let failedDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-retry-"));
    for (const d of ["inbox", "processing", "done", "failed"])
      mkdirSync(join(root, d), { recursive: true });
    inbox = join(root, "inbox");
    failedDir = join(root, "failed");
    cfg = { queueRoot: root, defaultTimeoutMinutes: 30 } as unknown as Config;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("retrying a parent drags back its cascaded dependents, transitively", async () => {
    writeFileSync(
      join(failedDir, "a.md"),
      "---\nid: a\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\n-->\n\n## Result\n\nx\n",
    );
    writeFileSync(
      join(failedDir, "b.md"),
      "---\nid: b\ndepends_on: [a]\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\ndependency_failed: a\n-->\n",
    );
    writeFileSync(
      join(failedDir, "c.md"),
      "---\nid: c\ndepends_on: [b]\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\ndependency_failed: b\n-->\n",
    );
    const out: string[] = [];
    const code = await runRetryCommand(cfg, ["a"], {}, { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(existsSync(join(inbox, "a.md"))).toBe(true);
    expect(existsSync(join(inbox, "b.md"))).toBe(true);
    expect(existsSync(join(inbox, "c.md"))).toBe(true);
    expect(out.join("")).toContain("requeued (dependent):");
  });

  it("an unrelated failed ticket is left alone", async () => {
    writeFileSync(
      join(failedDir, "a.md"),
      "---\nid: a\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\n-->\n",
    );
    writeFileSync(
      join(failedDir, "z.md"),
      "---\nid: z\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\n-->\n",
    );
    await runRetryCommand(cfg, ["a"], {}, { printFn: () => {} });
    expect(existsSync(join(failedDir, "z.md"))).toBe(true);
  });

  it("--all already sweeps a cascade-marked dependent in its own pass; the cascade loop must not re-requeue it", async () => {
    // --all's targets snapshot is EVERY entry in failed/, so the parent and its
    // dependent both get requeued by the main --all loop in the same pass —
    // the cascade while-loop below only exists to catch a dependent that
    // ISN'T also in the --all sweep. Here it is, so the cascade loop's
    // post-loop readdir of failed/ must come back empty and print nothing.
    writeFileSync(
      join(failedDir, "a.md"),
      "---\nid: a\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\n-->\n\n## Result\n\nx\n",
    );
    writeFileSync(
      join(failedDir, "b.md"),
      "---\nid: b\ndepends_on: [a]\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\ndependency_failed: a\n-->\n",
    );
    const out: string[] = [];
    const code = await runRetryCommand(cfg, [], { all: true }, { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    // Both land in inbox exactly once, under their own (un-suffixed) names —
    // a re-requeue attempt by the cascade loop would collide on submitTicket's
    // EEXIST guard, which would show up as a `failures++` error line, not a
    // duplicate file.
    expect(readdirSync(inbox).sort()).toEqual(["a.md", "b.md"]);
    expect(readdirSync(failedDir)).toHaveLength(0);
    const joined = out.join("");
    expect(joined).not.toContain("requeued (dependent):"); // already handled by --all
    expect(joined).not.toMatch(/junco retry:.*already queued/); // no collision either
    expect((joined.match(/^requeued: /gm) ?? []).length).toBe(2);
  });
});

describe("plan-set supersede guard (spec 2026-08-20 #293-critical-6)", () => {
  let root: string;
  let cfg: Config;
  let inbox: string;
  let failedDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-retry-superseded-"));
    for (const d of ["inbox", "processing", "done", "failed"])
      mkdirSync(join(root, d), { recursive: true });
    inbox = join(root, "inbox");
    failedDir = join(root, "failed");
    cfg = { queueRoot: root, defaultTimeoutMinutes: 30 } as unknown as Config;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // Same shape supersedeUnclaimed (planSets.ts) writes when a plan-set child
  // is disposed ahead of a recompile — never ran, pre-empted by a newer
  // approved plan revision.
  const supersededBody =
    "---\nid: p1-b\n---\nOld B body\n\n---\n<!-- junco-result\nstatus: failed\nsuperseded: rev2\n-->\n";

  it("--all skips a superseded ticket (stays in failed/, prints a skip line)", async () => {
    writeFileSync(join(failedDir, "p1-b.md"), supersededBody, "utf8");
    writeFileSync(
      join(failedDir, "ordinary.md"),
      "---\nid: ordinary\n---\nx\n\n---\n<!-- junco-result\nstatus: failed\n-->\n",
      "utf8",
    );
    const out: string[] = [];
    const code = await runRetryCommand(cfg, [], { all: true }, { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    // The superseded ticket is left exactly where it was — a fresh copy under
    // the same ticketId may already be running the real work.
    expect(existsSync(join(failedDir, "p1-b.md"))).toBe(true);
    expect(existsSync(join(inbox, "p1-b.md"))).toBe(false);
    // An ordinary failure in the same batch is unaffected.
    expect(existsSync(join(inbox, "ordinary.md"))).toBe(true);
    expect(out.join("")).toContain("skipped (superseded): p1-b.md");
  });

  it("an explicit retry by name still proceeds, but warns", async () => {
    writeFileSync(join(failedDir, "p1-b.md"), supersededBody, "utf8");
    const out: string[] = [];
    const code = await runRetryCommand(cfg, ["p1-b"], {}, { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(existsSync(join(inbox, "p1-b.md"))).toBe(true); // the operator asked by name — honored
    expect(existsSync(join(failedDir, "p1-b.md"))).toBe(false);
    expect(out.join("")).toContain(
      "junco retry: warning — p1-b.md was superseded by plan rev rev2; a newer copy may already be queued",
    );
  });
});
