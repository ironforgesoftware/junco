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
// Rule: notes_block_present
// ---------------------------------------------------------------------------

describe("notes_block_present", () => {
  it("present → no violation", () => {
    const result = lintTicket(VALID_BODY, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "notes_block_present");
    expect(v).toHaveLength(0);
  });

  it("missing notes block → error", () => {
    const body = [
      "## Summary\nDo a thing.\n",
      "## Steps\n",
      "### Step 1 — Do it\nsrc/index.ts\n```bash\ngit commit -m 'step 1'\n```\n",
      "## Verification\n```bash\nnpm test\n```\n",
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    const v = result.violations.filter((v) => v.rule === "notes_block_present");
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("error");
    expect(v[0].message).toMatch(/Notes for the agent/);
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

describe("lintTicket — clean ticket", () => {
  it("all-pass ticket returns ok with no violations", () => {
    const result = lintTicket(VALID_BODY, VALID_FM, { checkLabels: false });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.summary()).toBe("plan-lint: ok");
  });

  it("rule order: no_cd_in_verification is first", () => {
    // When multiple rules fire, no_cd_in_verification should appear first
    const body = [
      "## Verification\n```bash\ncd /tmp\nnpm test\n```\n",
      // missing notes block → notes_block_present
    ].join("\n");
    const result = lintTicket(body, VALID_FM, { checkLabels: false });
    expect(result.violations[0]?.rule).toBe("no_cd_in_verification");
  });
});
