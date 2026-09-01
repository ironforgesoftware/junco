import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LabelCache,
  LintResult,
  lintTicket,
  formatViolations,
  type LintViolation,
} from "../src/planLint.js";

// ---------------------------------------------------------------------------
// Shared fixture builders
// ---------------------------------------------------------------------------

/** Build a minimal valid ticket body with all required sections. */
function validBody({
  verificationCd = false,
  forbiddenPhrase = "",
  forbiddenInNotes = false,
  stepCd = false,
  filesSection = "",
  extraSteps = "",
} = {}): string {
  const verBlock = verificationCd
    ? "## Verification\n```bash\ncd /tmp\nnpm test\n```\n"
    : "## Verification\n```bash\nnpm test\n```\n";

  const forbidden = forbiddenPhrase ? (forbiddenInNotes ? "" : `${forbiddenPhrase}\n`) : "";

  const cdLine = stepCd ? "cd /Users/you/repo\n" : "";

  const step1 = `### Step 1 — Do the thing\n${forbidden}${cdLine}Edit src/index.ts here.\n\`\`\`bash\ngit commit -m "step 1"\n\`\`\`\n`;
  const step2 =
    extraSteps || `### Step 2 — Wrap up\nRun more.\n\`\`\`bash\ngit commit -m "step 2"\n\`\`\`\n`;

  const files =
    filesSection ||
    `## Files\n| Path | Action |\n|------|--------|\n| \`src/index.ts\` | modify |\n`;

  const notesContent = forbiddenInNotes && forbiddenPhrase ? `${forbiddenPhrase}\n` : "";

  return [
    "## Summary\nDo a thing.\n",
    files,
    "## Steps\n",
    step1,
    step2,
    verBlock,
    `## Notes for the agent (strict)\n${notesContent}Follow the rules. Be careful.\n`,
  ].join("\n");
}

// A representative valid ticket with src/index.ts referenced in steps
const VALID_BODY = validBody();
const VALID_FM: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// LintResult
// ---------------------------------------------------------------------------

describe("LintResult", () => {
  it("ok=true when no violations", () => {
    const r = new LintResult([]);
    expect(r.ok).toBe(true);
    expect(r.summary()).toBe("plan-lint: ok");
  });

  it("ok=true with only warnings", () => {
    const w: LintViolation = { rule: "r", severity: "warning", message: "m" };
    const r = new LintResult([w]);
    expect(r.ok).toBe(true);
    expect(r.summary()).toBe("plan-lint: 1 warning(s)");
  });

  it("ok=false when any error present", () => {
    const e: LintViolation = { rule: "r", severity: "error", message: "m" };
    const r = new LintResult([e]);
    expect(r.ok).toBe(false);
    expect(r.summary()).toBe("plan-lint: 1 error(s)");
  });

  it("summary with both errors and warnings", () => {
    const violations: LintViolation[] = [
      { rule: "r1", severity: "error", message: "e" },
      { rule: "r2", severity: "warning", message: "w" },
      { rule: "r3", severity: "warning", message: "w2" },
    ];
    const r = new LintResult(violations);
    expect(r.ok).toBe(false);
    expect(r.summary()).toBe("plan-lint: 1 error(s), 2 warning(s)");
  });

  it("errors and warnings getters filter correctly", () => {
    const violations: LintViolation[] = [
      { rule: "r1", severity: "error", message: "e" },
      { rule: "r2", severity: "warning", message: "w" },
    ];
    const r = new LintResult(violations);
    expect(r.errors).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// formatViolations
// ---------------------------------------------------------------------------

describe("formatViolations", () => {
  it("formats each violation as [severity] rule: message", () => {
    const violations: LintViolation[] = [
      { rule: "no_cd_in_verification", severity: "error", message: "bad cd" },
      { rule: "notes_block_present", severity: "warning", message: "missing" },
    ];
    const out = formatViolations(violations);
    expect(out).toBe(
      "[error] no_cd_in_verification: bad cd\n[warning] notes_block_present: missing",
    );
  });

  it("returns empty string for empty array", () => {
    expect(formatViolations([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Rule: no_cd_in_verification
// ---------------------------------------------------------------------------

describe("no_cd_in_verification", () => {
  it("clean ticket has no violations", () => {
    const result = lintTicket(VALID_BODY, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "no_cd_in_verification");
    expect(v).toHaveLength(0);
  });

  it("cd in verification bash block → error", () => {
    const body = validBody({ verificationCd: true });
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "no_cd_in_verification");
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("error");
    expect(v[0].message).toMatch(/cd/);
  });

  it("one report per fence, not per line", () => {
    const body = [
      "## Verification\n```bash\ncd /tmp\ncd /Users\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "no_cd_in_verification");
    expect(v).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rule: steps_have_commits
// ---------------------------------------------------------------------------

describe("steps_have_commits", () => {
  it("clean ticket with commits in every step → no violation", () => {
    const result = lintTicket(VALID_BODY, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "steps_have_commits");
    expect(v).toHaveLength(0);
  });

  it("step missing git commit → error", () => {
    const body = [
      "## Summary\nDo a thing.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `src/index.ts` | modify |\n",
      "## Steps\n",
      "### Step 1 — Do the thing\nsrc/index.ts\nRun the code.\n",
      "### Step 2 — Wrap up\nRun more.\n```bash\ngit commit -m 'step 2'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "steps_have_commits");
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("error");
    expect(v[0].message).toMatch(/Step 1/);
    expect(v[0].message).toMatch(/git commit/);
  });

  it("no step blocks → no violation", () => {
    const body = [
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "steps_have_commits");
    expect(v).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: files_table_referenced
// ---------------------------------------------------------------------------

describe("files_table_referenced", () => {
  it("all paths referenced → no violation", () => {
    const result = lintTicket(VALID_BODY, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "files_table_referenced");
    expect(v).toHaveLength(0);
  });

  it("path not in any step → warning", () => {
    const body = [
      "## Summary\nDo a thing.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `src/index.ts` | modify |\n| `src/orphan.ts` | new |\n",
      "## Steps\n",
      "### Step 1 — Do it\nsrc/index.ts\n```bash\ngit commit -m 'step 1'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "files_table_referenced");
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("warning");
    expect(v[0].message).toMatch(/src\/orphan\.ts/);
  });

  it("placeholder paths are skipped", () => {
    const body = [
      "## Summary\nDo a thing.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `src/a.ts` | new |\n| `path/to/file.ts` | new |\n",
      "## Steps\n",
      "### Step 1 — Do it\nsome content\n```bash\ngit commit -m 'step 1'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "files_table_referenced");
    expect(v).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// notes_block_present retired — the worker preamble now owns the discipline
// ---------------------------------------------------------------------------

describe("no Notes block requirement", () => {
  it("a ticket without a Notes block passes — the worker preamble carries the discipline", () => {
    const r = lintTicket("# T\n\n### Step 1\n\ngit commit -m x\n", {}, { checkLabels: false });
    expect(r.violations.map((v) => v.rule)).not.toContain("notes_block_present");
  });
});

// ---------------------------------------------------------------------------
// Rule: no_forbidden_phrases
// ---------------------------------------------------------------------------

describe("no_forbidden_phrases", () => {
  it("clean ticket → no violation", () => {
    const result = lintTicket(VALID_BODY, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "no_forbidden_phrases");
    expect(v).toHaveLength(0);
  });

  it("TBD before notes → error", () => {
    const body = validBody({ forbiddenPhrase: "TBD", forbiddenInNotes: false });
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "no_forbidden_phrases");
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("error");
    expect(v[0].message).toMatch(/TBD/);
  });

  it("'think carefully' before notes → error", () => {
    const body = [
      "## Summary\nthink carefully about this.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `src/index.ts` | modify |\n",
      "## Steps\n",
      "### Step 1 — Do it\nsrc/index.ts\n```bash\ngit commit -m 'step 1'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "no_forbidden_phrases");
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/think carefully/i);
  });

  it("'Similar to Step 2' → error", () => {
    const body = [
      "## Summary\nDo a thing.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `src/index.ts` | modify |\n",
      "## Steps\n",
      "### Step 1 — Do it\nsrc/index.ts Similar to Step 2 here.\n```bash\ngit commit -m 'step 1'\n```\n",
      "### Step 2 — Follow up\nsrc/index.ts\n```bash\ngit commit -m 'step 2'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "no_forbidden_phrases");
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/Similar to Step/i);
  });

  it("forbidden phrase AFTER Notes section → no violation", () => {
    const body = [
      "## Summary\nDo a thing.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `src/index.ts` | modify |\n",
      "## Steps\n",
      "### Step 1 — Do it\nsrc/index.ts\n```bash\ngit commit -m 'step 1'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nThink carefully — this is intentional. TBD here is ok.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "no_forbidden_phrases");
    expect(v).toHaveLength(0);
  });

  it("'consider all edge cases' → error", () => {
    const body = [
      "## Summary\nConsider all edge cases.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `src/index.ts` | modify |\n",
      "## Steps\n",
      "### Step 1 — Do it\nsrc/index.ts\n```bash\ngit commit -m 'step 1'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "no_forbidden_phrases");
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/consider all/i);
  });

  it("'be thorough' → error", () => {
    const body = [
      "## Summary\nBe thorough in your approach.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `src/index.ts` | modify |\n",
      "## Steps\n",
      "### Step 1 — Do it\nsrc/index.ts\n```bash\ngit commit -m 'step 1'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "no_forbidden_phrases");
    expect(v).toHaveLength(1);
  });

  it("'fill in later' → error", () => {
    const body = [
      "## Summary\nfill in later.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `src/index.ts` | modify |\n",
      "## Steps\n",
      "### Step 1 — Do it\nsrc/index.ts\n```bash\ngit commit -m 'step 1'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "no_forbidden_phrases");
    expect(v).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rule: no_cd_in_steps
// ---------------------------------------------------------------------------

describe("no_cd_in_steps", () => {
  it("no absolute cd → no violation", () => {
    const result = lintTicket(VALID_BODY, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "no_cd_in_steps");
    expect(v).toHaveLength(0);
  });

  it("absolute cd /Users/... in step → warning", () => {
    const body = validBody({ stepCd: true });
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "no_cd_in_steps");
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("warning");
    expect(v[0].message).toMatch(/cd\s+\/Users/);
  });

  it("cd /Volumes, /home, /opt, /var also triggers warning", () => {
    for (const prefix of ["/Volumes", "/home", "/opt", "/var"]) {
      const body = [
        "## Summary\nDo a thing.\n",
        "## Files\n| Path | Action |\n|------|--------|\n| `src/index.ts` | modify |\n",
        "## Steps\n",
        `### Step 1 — Do it\nsrc/index.ts\ncd ${prefix}/thing\n\`\`\`bash\ngit commit -m 'step 1'\n\`\`\`\n`,
        "## Verification\n```bash\nnpm test\n```\n",
        "## Notes for the agent (strict)\nFollow rules.\n",
      ].join("\n");
      const result = lintTicket(body, VALID_FM, { checkLabels: false });
      const v = result.violations.filter((v) => v.rule === "no_cd_in_steps");
      expect(v).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Rule: files_paths_exist
// ---------------------------------------------------------------------------

describe("files_paths_exist", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "junco-lint-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("no repoPath → no violations", () => {
    const body = validBody();
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "files_paths_exist");
    expect(v).toHaveLength(0);
  });

  it("new file that already exists → warning", () => {
    // Create a file that the ticket marks as 'new'
    writeFileSync(join(tmpDir, "already.ts"), "");
    const body = [
      "## Summary\nDo a thing.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `already.ts` | new |\n",
      "## Steps\n",
      "### Step 1 — Do it\nalready.ts\n```bash\ngit commit -m 'step 1'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false, repoPath: tmpDir });
    const v = result.violations.filter((v) => v.rule === "files_paths_exist");
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("warning");
    expect(v[0].message).toMatch(/already\.ts/);
    expect(v[0].message).toMatch(/already exists/);
  });

  it("modify file that does not exist → warning", () => {
    const body = [
      "## Summary\nDo a thing.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `missing.ts` | modify |\n",
      "## Steps\n",
      "### Step 1 — Do it\nmissing.ts\n```bash\ngit commit -m 'step 1'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false, repoPath: tmpDir });
    const v = result.violations.filter((v) => v.rule === "files_paths_exist");
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("warning");
    expect(v[0].message).toMatch(/missing\.ts/);
    expect(v[0].message).toMatch(/does not exist/);
  });

  it("hedged action 'new (if absent)' is skipped", () => {
    writeFileSync(join(tmpDir, "maybe.ts"), "");
    const body = [
      "## Summary\nDo a thing.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `maybe.ts` | new (if absent) |\n",
      "## Steps\n",
      "### Step 1 — Do it\nmaybe.ts\n```bash\ngit commit -m 'step 1'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false, repoPath: tmpDir });
    const v = result.violations.filter((v) => v.rule === "files_paths_exist");
    expect(v).toHaveLength(0);
  });

  it("hedged action with '?' is skipped", () => {
    const body = [
      "## Summary\nDo a thing.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `missing.ts` | modify? |\n",
      "## Steps\n",
      "### Step 1 — Do it\nmissing.ts\n```bash\ngit commit -m 'step 1'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false, repoPath: tmpDir });
    const v = result.violations.filter((v) => v.rule === "files_paths_exist");
    expect(v).toHaveLength(0);
  });

  it("placeholder paths (src/a.ts, path/...) are skipped", () => {
    const body = [
      "## Summary\nDo a thing.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `src/a.ts` | new |\n| `path/to/thing.ts` | modify |\n",
      "## Steps\n",
      "### Step 1 — Do it\nsrc/a.ts\n```bash\ngit commit -m 'step 1'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false, repoPath: tmpDir });
    const v = result.violations.filter((v) => v.rule === "files_paths_exist");
    expect(v).toHaveLength(0);
  });

  it("delete action on missing file → warning", () => {
    const body = [
      "## Summary\nDo a thing.\n",
      "## Files\n| Path | Action |\n|------|--------|\n| `ghost.ts` | delete |\n",
      "## Steps\n",
      "### Step 1 — Do it\nghost.ts\n```bash\ngit commit -m 'step 1'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
      "## Notes for the agent (strict)\nFollow rules.\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false, repoPath: tmpDir });
    const v = result.violations.filter((v) => v.rule === "files_paths_exist");
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/does not exist/);
  });
});

// ---------------------------------------------------------------------------
// Rule: labels_exist
// ---------------------------------------------------------------------------

describe("labels_exist", () => {
  const repoNwo = "test-org/test-repo";
  const fm = { labels: ["bug", "enhancement"] };

  it("all labels found → no violation", () => {
    const fetchLabels = (_nwo: string) => new Set(["bug", "enhancement", "docs"]);
    const result = lintTicket(VALID_BODY, fm, {
      repoNwo,
      fetchLabels,
      checkLabels: true,
    });
    const v = result.violations.filter((v) => v.rule === "labels_exist");
    expect(v).toHaveLength(0);
  });

  it("missing label → error", () => {
    const fetchLabels = (_nwo: string) => new Set(["docs"]);
    const result = lintTicket(VALID_BODY, fm, {
      repoNwo,
      fetchLabels,
      checkLabels: true,
    });
    const v = result.violations.filter((v) => v.rule === "labels_exist");
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("error");
    expect(v[0].message).toMatch(/bug/);
    expect(v[0].message).toMatch(/enhancement/);
  });

  it("no repoNwo → warning", () => {
    const fetchLabels = (_nwo: string) => new Set(["bug"]);
    const result = lintTicket(VALID_BODY, fm, {
      repoNwo: undefined,
      fetchLabels,
      checkLabels: true,
    });
    const v = result.violations.filter((v) => v.rule === "labels_exist");
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("warning");
    expect(v[0].message).toMatch(/no repo/i);
  });

  it("empty fetch result → warning (gh could not validate)", () => {
    const fetchLabels = (_nwo: string) => new Set<string>();
    const result = lintTicket(VALID_BODY, fm, {
      repoNwo,
      fetchLabels,
      checkLabels: true,
    });
    const v = result.violations.filter((v) => v.rule === "labels_exist");
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("warning");
    expect(v[0].message).toMatch(/Could not fetch/);
  });

  it("checkLabels=false → skipped entirely", () => {
    const fetchLabels = (_nwo: string): Set<string> => {
      throw new Error("should not be called");
    };
    const result = lintTicket(VALID_BODY, fm, {
      repoNwo,
      fetchLabels,
      checkLabels: false,
    });
    const v = result.violations.filter((v) => v.rule === "labels_exist");
    expect(v).toHaveLength(0);
  });

  it("no labels in frontmatter → skipped", () => {
    const fetchLabels = (_nwo: string): Set<string> => {
      throw new Error("should not be called");
    };
    const result = lintTicket(
      VALID_BODY,
      {},
      {
        repoNwo,
        fetchLabels,
        checkLabels: true,
      },
    );
    const v = result.violations.filter((v) => v.rule === "labels_exist");
    expect(v).toHaveLength(0);
  });

  it("LabelCache hit avoids second fetch call", () => {
    let callCount = 0;
    const fetchLabels = (_nwo: string) => {
      callCount++;
      return new Set(["bug", "enhancement"]);
    };
    const cache = new LabelCache(300);
    // Run twice; second call should hit cache
    lintTicket(VALID_BODY, fm, { repoNwo, fetchLabels, checkLabels: true, labelCache: cache });
    lintTicket(VALID_BODY, fm, { repoNwo, fetchLabels, checkLabels: true, labelCache: cache });
    expect(callCount).toBe(1);
  });

  it("LabelCache TTL expiry causes re-fetch", () => {
    let callCount = 0;
    const fetchLabels = (_nwo: string) => {
      callCount++;
      return new Set(["bug", "enhancement"]);
    };
    // TTL of -1 seconds — always expired the instant it is stored
    const cache = new LabelCache(-1);
    lintTicket(VALID_BODY, fm, { repoNwo, fetchLabels, checkLabels: true, labelCache: cache });
    lintTicket(VALID_BODY, fm, { repoNwo, fetchLabels, checkLabels: true, labelCache: cache });
    expect(callCount).toBe(2);
  });

  // Regression: the real _fetchRepoLabels path must honor the configured gh
  // binary (not a hardcoded /opt/homebrew/bin/gh). No fetchLabels injection here
  // — this exercises execFileSync against a fake gh script passed via ghBin.
  it("ghBin is honored by the real label fetch (no fetchLabels injection)", () => {
    const binDir = mkdtempSync(join(tmpdir(), "junco-lint-ghbin-"));
    const fakeGh = join(binDir, "gh");
    // Emit one label per line — _fetchRepoLabels reads `-q .[].name` output.
    writeFileSync(fakeGh, "#!/bin/sh\nprintf 'bug\\nenhancement\\ndocs\\n'\n", { mode: 0o755 });
    try {
      const result = lintTicket(VALID_BODY, fm, { repoNwo, checkLabels: true, ghBin: fakeGh });
      // All ticket labels (bug, enhancement) are present → no labels_exist violation.
      expect(result.violations.filter((v) => v.rule === "labels_exist")).toHaveLength(0);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  // Regression: the daemon's bot GH_CONFIG_DIR must reach this one
  // execFileSync bypass of git.ts — closes the last gh subprocess bypass.
  it("threads ghEnv into the label fetch (bot GH_CONFIG_DIR)", () => {
    const binDir = mkdtempSync(join(tmpdir(), "junco-lint-ghenv-"));
    const fakeGh = join(binDir, "gh");
    const envOut = join(binDir, "env.txt");
    writeFileSync(
      fakeGh,
      `#!/bin/sh\necho "\${GH_CONFIG_DIR:-unset}" > ${JSON.stringify(envOut)}\nprintf 'bug\\nenhancement\\n'\n`,
      { mode: 0o755 },
    );
    try {
      const result = lintTicket(VALID_BODY, fm, {
        repoNwo,
        checkLabels: true,
        ghBin: fakeGh,
        ghEnv: { GH_CONFIG_DIR: "/sbx/junco-gh" },
      });
      expect(result.violations.filter((v) => v.rule === "labels_exist")).toHaveLength(0);
      expect(readFileSync(envOut, "utf8").trim()).toBe("/sbx/junco-gh");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  // A ghEnv-free call must still work (env stays undefined → inherits process.env).
  it("ghEnv-free call still works (no env threaded)", () => {
    const binDir = mkdtempSync(join(tmpdir(), "junco-lint-noghenv-"));
    const fakeGh = join(binDir, "gh");
    writeFileSync(fakeGh, "#!/bin/sh\nprintf 'bug\\nenhancement\\n'\n", { mode: 0o755 });
    try {
      const result = lintTicket(VALID_BODY, fm, { repoNwo, checkLabels: true, ghBin: fakeGh });
      expect(result.violations.filter((v) => v.rule === "labels_exist")).toHaveLength(0);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Full valid ticket integration test
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Rule: github_request_scope
// ---------------------------------------------------------------------------

describe("github_request_scope", () => {
  it("warns (never errors) when github_request rides a fork-push ticket", () => {
    const fm = { ...VALID_FM, push_remote: "fork", github_request: { create_issue: true } };
    const result = lintTicket(VALID_BODY, fm, { checkLabels: false });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.rule === "github_request_scope")).toBe(true);
  });

  it("warns when the ticket already carries a github: block", () => {
    const fm = {
      ...VALID_FM,
      github: { nwo: "acme/api", issue: 3, kind: "pr" },
      github_request: { create_issue: true },
    };
    const result = lintTicket(VALID_BODY, fm, { checkLabels: false });
    expect(result.warnings.some((w) => w.rule === "github_request_scope")).toBe(true);
  });

  it("warns when github_request rides an amend ticket", () => {
    const fm = { ...VALID_FM, amends_pr: 42, github_request: { create_issue: true } };
    const result = lintTicket(VALID_BODY, fm, { checkLabels: false });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.rule === "github_request_scope")).toBe(true);
  });

  it("warns on a non-mapping github_request, stays silent on a well-scoped one and on absence", () => {
    const bad = lintTicket(
      VALID_BODY,
      { ...VALID_FM, github_request: true },
      { checkLabels: false },
    );
    expect(bad.warnings.some((w) => w.rule === "github_request_scope")).toBe(true);
    const good = lintTicket(
      VALID_BODY,
      { ...VALID_FM, github_request: { create_issue: true } },
      { checkLabels: false },
    );
    expect(good.violations.some((v) => v.rule === "github_request_scope")).toBe(false);
    const absent = lintTicket(VALID_BODY, VALID_FM, { checkLabels: false });
    expect(absent.violations.some((v) => v.rule === "github_request_scope")).toBe(false);
  });

  // #210: an UNPARSEABLE github: block does NOT suppress fulfillment, so the
  // lint must not claim "already carries a github: block; will be ignored".
  it("does not warn about a github: block that would not parse (fulfillment proceeds) (#210)", () => {
    for (const bad of ["banana", { issue: 0 }, { nwo: "acme/api", issue: 3 /* no kind */ }]) {
      const fm = { ...VALID_FM, github: bad, github_request: { create_issue: true } };
      const result = lintTicket(VALID_BODY, fm, { checkLabels: false });
      expect(result.warnings.some((w) => w.rule === "github_request_scope")).toBe(false);
    }
    // A parseable block still warns.
    const valid = lintTicket(
      VALID_BODY,
      {
        ...VALID_FM,
        github: { nwo: "acme/api", issue: 3, kind: "pr" },
        github_request: { create_issue: true },
      },
      { checkLabels: false },
    );
    expect(valid.warnings.some((w) => w.rule === "github_request_scope")).toBe(true);
  });

  // #210: fulfillment skips ANY non-origin push_remote, not just "fork".
  it("warns on push_remote: upstream (any non-origin remote), not only fork (#210)", () => {
    const up = lintTicket(
      VALID_BODY,
      { ...VALID_FM, push_remote: "upstream", github_request: { create_issue: true } },
      { checkLabels: false },
    );
    expect(up.warnings.some((w) => w.rule === "github_request_scope")).toBe(true);
  });

  // #210: a malformed amends_pr derives to null → fulfillment proceeds → no warn.
  it("does not warn on a malformed amends_pr; warns on a real one (#210)", () => {
    const bad = lintTicket(
      VALID_BODY,
      { ...VALID_FM, amends_pr: "banana", github_request: { create_issue: true } },
      { checkLabels: false },
    );
    expect(bad.warnings.some((w) => w.rule === "github_request_scope")).toBe(false);
    const good = lintTicket(
      VALID_BODY,
      { ...VALID_FM, amends_pr: 42, github_request: { create_issue: true } },
      { checkLabels: false },
    );
    expect(good.warnings.some((w) => w.rule === "github_request_scope")).toBe(true);
  });

  // #210: a non-boolean create_issue (the likeliest typo) now gets an advisory.
  it('warns when create_issue is a non-boolean (yes / 1 / "true"); silent on real booleans (#210)', () => {
    for (const ci of ["yes", 1, "true", "on"]) {
      const result = lintTicket(
        VALID_BODY,
        { ...VALID_FM, github_request: { create_issue: ci } },
        { checkLabels: false },
      );
      expect(
        result.warnings.some(
          (w) =>
            w.rule === "github_request_scope" && /create_issue must be the boolean/.test(w.message),
        ),
      ).toBe(true);
      expect(result.ok).toBe(true); // advisory only, never blocks
    }
    // Real booleans get no advisory (true = opt-in, false = deliberate opt-out).
    for (const ci of [true, false]) {
      const result = lintTicket(
        VALID_BODY,
        { ...VALID_FM, github_request: { create_issue: ci } },
        { checkLabels: false },
      );
      expect(result.warnings.some((w) => /create_issue must be the boolean/.test(w.message))).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Apply tickets (junco-patch fence): prose rules skipped, patch_* rules run
// ---------------------------------------------------------------------------

describe("apply tickets", () => {
  // Mirrors tests/patchTicket.test.ts's ONE/fence fixtures: a minimal
  // one-patch git format-patch series wrapped in a junco-patch fence.
  const ONE_PATCH = `From 9f3a1c2e0000000000000000000000000000abcd Mon Sep 17 00:00:00 2001
From: Dispatcher <d@example.com>
Date: Sun, 31 Aug 2026 12:00:00 -0700
Subject: [PATCH 1/1] feat: add a level

---
 game.js | 1 +
 1 file changed, 1 insertion(+)

diff --git a/game.js b/game.js
index 1111111..2222222 100644
--- a/game.js
+++ b/game.js
@@ -1,2 +1,3 @@
 const LEVELS = [
+  "new",
 ];
`;

  const fence = (body: string, tag = "junco-patch"): string =>
    `## Why\n\nbecause\n\n\`\`\`\`${tag}\n${body}\`\`\`\`\n\n## Verification\n\n\`\`\`bash\nnode --check game.js\n\`\`\`\n`;

  const patchBody = fence(ONE_PATCH);

  it("skips the prose rules for a patch ticket", () => {
    const r = lintTicket(patchBody, {}, { checkLabels: false });
    const rules = r.violations.map((v) => v.rule);
    expect(rules).not.toContain("steps_have_commits");
    expect(rules).not.toContain("files_table_referenced");
    expect(r.ok).toBe(true);
  });

  it("errors on a junco-patch fence that is not a well-formed series", () => {
    // Prose-shaped ON PURPOSE: a Files table and a commit-less Step would both
    // trip the prose rules if the mode gate keyed on "the series PARSES"
    // instead of "a patch fence is PRESENT". A malformed series must report
    // exactly one thing — patch_parses — not a pile of irrelevant prose
    // errors, so this fixture is what makes the gate's condition observable.
    const bad = [
      "## Why",
      "",
      "x",
      "",
      "## Files",
      "",
      "| `src/a.ts` | modify |",
      "| --- | --- |",
      "",
      "### Step 1: do a thing",
      "",
      "no commit here",
      "",
      "```junco-patch",
      "not a patch",
      "```",
      "",
    ].join("\n");
    const r = lintTicket(bad, {}, { checkLabels: false });
    const rules = r.violations.map((v) => v.rule);
    expect(rules).toContain("patch_parses");
    expect(rules).not.toContain("steps_have_commits");
    expect(rules).not.toContain("files_table_referenced");
    expect(r.ok).toBe(false);
  });

  it("errors on traversal paths and on a binary hunk", () => {
    // Case 1: a diff --git line naming a path outside the repo.
    const traversal = `From 9f3a1c2e0000000000000000000000000000abcd Mon Sep 17 00:00:00 2001
From: Dispatcher <d@example.com>
Date: Sun, 31 Aug 2026 12:00:00 -0700
Subject: [PATCH 1/1] evil

---
 ../../etc/passwd | 1 +
 1 file changed, 1 insertion(+)

diff --git a/../../etc/passwd b/../../etc/passwd
index 1111111..2222222 100644
--- a/../../etc/passwd
+++ b/../../etc/passwd
@@ -1,2 +1,3 @@
 root:x:0:0
+evil
`;
    const rTraversal = lintTicket(fence(traversal), {}, { checkLabels: false });
    expect(rTraversal.violations.map((v) => v.rule)).toContain("patch_paths_sane");
    expect(rTraversal.ok).toBe(false);

    // Case 2: a diff --git hunk that's binary — bytes no reviewer can read.
    const binary = `From 9f3a1c2e0000000000000000000000000000abcd Mon Sep 17 00:00:00 2001
From: Dispatcher <d@example.com>
Date: Sun, 31 Aug 2026 12:00:00 -0700
Subject: [PATCH 1/1] add binary

---
 image.png | Bin 0 -> 100 bytes
 1 file changed, 0 insertions(+), 0 deletions(-)

diff --git a/image.png b/image.png
new file mode 100644
index 0000000..1111111
GIT binary patch
literal 100
zcmZQzWMZQ
`;
    const rBinary = lintTicket(fence(binary), {}, { checkLabels: false });
    expect(rBinary.violations.map((v) => v.rule)).toContain("patch_paths_sane");
    expect(rBinary.ok).toBe(false);
  });

  it("warns when an apply ticket has no Verification block", () => {
    const noVerify = `## Why\n\nbecause\n\n\`\`\`\`junco-patch\n${ONE_PATCH}\`\`\`\`\n`;
    const r = lintTicket(noVerify, {}, { checkLabels: false });
    const v = r.violations.find((x) => x.rule === "patch_has_verification");
    expect(v?.severity).toBe("warning");
    expect(r.ok).toBe(true);
  });

  it("still applies the shared rules to a patch ticket", () => {
    const tbd = `## Why\n\nTBD\n\n\`\`\`\`junco-patch\n${ONE_PATCH}\`\`\`\`\n\n## Verification\n\n\`\`\`bash\nnode --check game.js\n\`\`\`\n`;
    expect(lintTicket(tbd, {}, { checkLabels: false }).violations.map((v) => v.rule)).toContain(
      "no_forbidden_phrases",
    );
  });
});

// ---------------------------------------------------------------------------
// Full valid ticket integration test
// ---------------------------------------------------------------------------

describe("lintTicket — clean ticket", () => {
  it("all-pass ticket returns ok with no violations", () => {
    const result = lintTicket(VALID_BODY, VALID_FM, { checkLabels: false });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.summary()).toBe("plan-lint: ok");
  });

  it("rule order: no_cd_in_verification is first", () => {
    // When multiple rules fire, no_cd_in_verification should appear first
    const body = ["## Verification\n```bash\ncd /tmp\nnpm test\n```\n"].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    expect(result.violations[0]?.rule).toBe("no_cd_in_verification");
  });
});
