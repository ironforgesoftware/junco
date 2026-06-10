/**
 * Pre-claim deterministic ticket validation.
 *
 * Faithful TypeScript port of plan_lint.py.
 *
 * Junco's worker calls `lintTicket()` after parsing a ticket from inbox/.
 * Tickets that fail any error-severity rule are routed directly to failed/
 * with a `phase_error` like `plan-lint: no_cd_in_verification: ...` — they
 * never reach the agent. Warnings are logged but do not block.
 *
 * Rules enforced:
 * - no_cd_in_verification: no `cd ` lines inside ## Verification fenced bash
 * - steps_have_commits:    every ### Step N block has at least one `git commit`
 * - files_table_referenced: every path in the Files table appears in a Step body
 * - files_paths_exist:     filesystem-aware Files-table path validation
 * - notes_block_present:   strict "Notes for the agent" block is present
 * - no_forbidden_phrases:  no TBD / "Similar to Step N" / "think carefully" / etc.
 * - no_cd_in_steps (warn): no absolute `cd /Users/...` in Step bodies
 * - labels_exist:          frontmatter `labels:` exist on the GitHub repo
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface LintViolation {
  rule: string;
  severity: "error" | "warning";
  message: string;
}

export class LintResult {
  readonly violations: LintViolation[];

  constructor(violations: LintViolation[] = []) {
    this.violations = violations;
  }

  get ok(): boolean {
    return !this.violations.some((v) => v.severity === "error");
  }

  get errors(): LintViolation[] {
    return this.violations.filter((v) => v.severity === "error");
  }

  get warnings(): LintViolation[] {
    return this.violations.filter((v) => v.severity === "warning");
  }

  summary(): string {
    if (this.ok && this.warnings.length === 0) {
      return "plan-lint: ok";
    }
    const parts: string[] = [];
    if (this.errors.length > 0) {
      parts.push(`${this.errors.length} error(s)`);
    }
    if (this.warnings.length > 0) {
      parts.push(`${this.warnings.length} warning(s)`);
    }
    return "plan-lint: " + parts.join(", ");
  }
}

// ---------------------------------------------------------------------------
// Locators / helpers
// ---------------------------------------------------------------------------

// ```bash\n...\n``` or ```sh\n...\n``` — DOTALL (s flag)
const _BASH_FENCE_RE = /```(?:bash|sh)?\n([\s\S]*?)```/g;

// Matches the path column (first backtick-wrapped cell) of a Files table row
const _FILES_TABLE_ROW_RE = /^\|\s*`([^`]+)`\s*\|/gm;

// Captures (path, action) — first and second column of the Files table row
const _FILES_TABLE_PATH_ACTION_RE = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/gm;

// ### Step N heading (possibly with trailing text)
const _STEP_HEADER_RE = /^###\s+Step\s+\d+[^\n]*$/gm;

// git commit (word boundary on either side)
const _GIT_COMMIT_RE = /\bgit\s+commit\b/g;

// Placeholder paths from TEMPLATE.md — skip these in filesystem checks
const _PLACEHOLDER_PATH_RE = /^(?:src\/[abc]\.ts|path\/.*)$/;

/**
 * Return the body of a markdown ## section by heading prefix.
 * Matches the first ## line whose text starts with `heading`, returns the
 * text up to the next ## heading (or end of body). Returns null if not found.
 * Python: re.MULTILINE | re.DOTALL → /ms flags
 */
function _section(body: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Python used a single (?ms) regex ending in `\Z`; JS has no `\Z`, so we find
  // the heading then slice to the next `## ` (or end of body) — same result.
  const headingPat = new RegExp(`^##\\s+${escaped}[^\\n]*$`, "m");
  const hm = headingPat.exec(body);
  if (!hm) return null;
  const afterHeading = body.slice(hm.index + hm[0].length);
  const nextH2 = /^##\s/m.exec(afterHeading);
  return nextH2 ? afterHeading.slice(0, nextH2.index) : afterHeading;
}

/**
 * Split body into [stepLabel, stepBody] pairs by ### Step N headings.
 *
 * A step's body extends to the next ### Step heading OR the next ## heading
 * (whichever comes first), so we don't pull content from later sections.
 * Python parity: _step_blocks(body)
 */
function _stepBlocks(body: string): Array<[string, string]> {
  // Collect all step header matches
  const matches: RegExpExecArray[] = [];
  const re = new RegExp(_STEP_HEADER_RE.source, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    matches.push(m);
  }

  const blocks: Array<[string, string]> = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const start = match.index;
    const nextStep = i + 1 < matches.length ? matches[i + 1].index : body.length;

    // Also stop at next ## heading
    const afterMatchEnd = match.index + match[0].length;
    const bodyAfter = body.slice(afterMatchEnd);
    const h2Match = /^##\s/m.exec(bodyAfter);
    const h2Offset = h2Match ? afterMatchEnd + h2Match.index : body.length;

    const end = Math.min(nextStep, h2Offset);
    blocks.push([match[0].trim(), body.slice(start, end)]);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkNoCdInVerification(body: string): LintViolation[] {
  const section = _section(body, "Verification");
  if (section === null) return [];

  const violations: LintViolation[] = [];
  const re = new RegExp(_BASH_FENCE_RE.source, "gs");
  let fence: RegExpExecArray | null;
  while ((fence = re.exec(section)) !== null) {
    const fenceContent = fence[1];
    let reported = false;
    for (const line of fenceContent.split("\n")) {
      if (reported) break;
      const stripped = line.trim();
      if (/^cd\s+\S/.test(stripped)) {
        violations.push({
          rule: "no_cd_in_verification",
          severity: "error",
          message:
            `Verification fenced block contains \`cd\` line: ${JSON.stringify(stripped)}. ` +
            "Junco runs the block with cwd=<worktree>; a leading `cd` moves " +
            "out of the worktree and verification fails for the wrong reason.",
        });
        reported = true; // one report per fence is enough
      }
    }
  }
  return violations;
}

function checkStepsHaveCommits(body: string): LintViolation[] {
  const blocks = _stepBlocks(body);
  if (blocks.length === 0) return [];

  const violations: LintViolation[] = [];
  for (const [label, block] of blocks) {
    const commits = block.match(_GIT_COMMIT_RE);
    if (!commits || commits.length === 0) {
      violations.push({
        rule: "steps_have_commits",
        severity: "error",
        message: `${label} has no \`git commit\` line. Each step must end with a commit.`,
      });
    }
  }
  return violations;
}

function checkFilesTableReferenced(body: string): LintViolation[] {
  const section = _section(body, "Files");
  if (section === null) return [];

  const re = new RegExp(_FILES_TABLE_ROW_RE.source, "gm");
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    paths.push(m[1]);
  }
  if (paths.length === 0) return [];

  // Build rest_of_body: body without the Files section
  const filesIdx = body.indexOf("## Files");
  if (filesIdx < 0) return [];
  const after = body.slice(filesIdx + 1);
  const nextH2 = /^##\s/m.exec(after);
  const filesEnd = nextH2 ? filesIdx + 1 + nextH2.index : body.length;
  const restOfBody = body.slice(0, filesIdx) + body.slice(filesEnd);

  const placeholderRe = /^(?:src\/[ab]\.ts|src\/c\.ts|path\/.*)$/;
  const violations: LintViolation[] = [];
  for (const path of paths) {
    if (placeholderRe.test(path)) continue;
    if (!restOfBody.includes(path)) {
      violations.push({
        rule: "files_table_referenced",
        severity: "warning",
        message:
          `Files table lists \`${path}\` but it is not referenced in any Step. ` +
          "Either remove the row or add a Step that touches it.",
      });
    }
  }
  return violations;
}

function checkFilesPathsExist(body: string, repoPath: string | null | undefined): LintViolation[] {
  if (!repoPath) return [];

  // Validate repoPath is a real directory
  try {
    if (!existsSync(repoPath)) return [];
  } catch {
    return [];
  }

  const section = _section(body, "Files");
  if (section === null) return [];

  const re = new RegExp(_FILES_TABLE_PATH_ACTION_RE.source, "gm");
  const rows: Array<[string, string]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    rows.push([m[1], m[2]]);
  }
  if (rows.length === 0) return [];

  const violations: LintViolation[] = [];
  for (let [path, action] of rows) {
    path = path.trim();
    action = action.trim().toLowerCase();
    if (_PLACEHOLDER_PATH_RE.test(path)) continue;
    // Skip hedged actions
    if (
      action.includes("conditional") ||
      action.includes("if absent") ||
      action.includes("if missing") ||
      action.includes("?")
    ) {
      continue;
    }
    const full = join(repoPath, path);
    if (action.includes("new") && !action.includes("modify")) {
      // Action says "new" → path SHOULD NOT exist in source
      if (existsSync(full)) {
        violations.push({
          rule: "files_paths_exist",
          severity: "warning",
          message:
            `Files table marks \`${path}\` as \`${action}\` but it already exists ` +
            `in ${repoPath}. The agent may waste time reconciling spec vs reality. ` +
            "Update the action to `modify` or remove the row.",
        });
      }
    } else if (
      action.includes("modify") ||
      action.includes("edit") ||
      action.includes("delete") ||
      action.includes("rename")
    ) {
      // Action expects existing file → path SHOULD exist
      if (!existsSync(full)) {
        violations.push({
          rule: "files_paths_exist",
          severity: "warning",
          message:
            `Files table marks \`${path}\` as \`${action}\` but the path does not ` +
            `exist in ${repoPath}. Either fix the path, change the action to \`new\`, ` +
            "or remove the row.",
        });
      }
    }
  }
  return violations;
}

function checkNotesBlockPresent(body: string): LintViolation[] {
  if (/^##\s+Notes for the agent\s*\(strict/m.test(body)) return [];
  return [
    {
      rule: "notes_block_present",
      severity: "error",
      message:
        "Strict 'Notes for the agent' section is missing. " +
        "Copy verbatim from TEMPLATE.md — this is the anti-loop payload.",
    },
  ];
}

const _FORBIDDEN_PHRASES: Array<[string, string]> = [
  [String.raw`\bTBD\b`, "TBD"],
  [String.raw`\bSimilar to Step\s+\d+\b`, "Similar to Step N"],
  [String.raw`\bthink carefully\b`, "think carefully"],
  [String.raw`\bconsider all (?:cases|edge cases)\b`, "consider all (edge) cases"],
  [String.raw`\bbe thorough\b`, "be thorough"],
  [String.raw`\bfill in later\b`, "fill in later"],
];

function checkNoForbiddenPhrases(body: string): LintViolation[] {
  /**
   * Forbidden phrases — known to trigger looping or signal placeholders.
   *
   * Skips matches inside the body of the strict "Notes for the agent" block,
   * where words like "carefully" may legitimately appear in copy-verbatim text.
   */
  const notesIdx = body.indexOf("## Notes for the agent");
  const scanTarget = notesIdx < 0 ? body : body.slice(0, notesIdx);

  const violations: LintViolation[] = [];
  for (const [pattern, label] of _FORBIDDEN_PHRASES) {
    const re = new RegExp(pattern, "i");
    const m = re.exec(scanTarget);
    if (m) {
      violations.push({
        rule: "no_forbidden_phrases",
        severity: "error",
        message:
          `Body contains forbidden phrase: '${label}' (matched ${JSON.stringify(m[0])}). ` +
          "These trigger looping or signal unfilled placeholders.",
      });
    }
  }
  return violations;
}

function checkNoCdInSteps(body: string): LintViolation[] {
  /**
   * Warn on absolute `cd /Users/...` inside Step bodies.
   *
   * This is a precursor habit that often bleeds into the Verification block.
   * Step commands should be relative to the worktree root.
   */
  const blocks = _stepBlocks(body);
  const violations: LintViolation[] = [];
  for (const [label, block] of blocks) {
    const m = /\bcd\s+\/(?:Users|Volumes|home|opt|var)\b/.exec(block);
    if (m) {
      violations.push({
        rule: "no_cd_in_steps",
        severity: "warning",
        message:
          `${label} contains an absolute \`cd\` command: ${JSON.stringify(m[0])}. ` +
          "Step commands should be relative to the worktree root. " +
          "This habit often bleeds into the Verification block.",
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Label cache + check
// ---------------------------------------------------------------------------

export class LabelCache {
  /**
   * In-memory TTL cache of `gh label list` results, keyed by repo nwo.
   *
   * Default TTL 5 minutes — short enough that label changes propagate in one
   * cycle, long enough that back-to-back tickets to the same repo don't
   * repeat the network call.
   */
  private readonly ttlMs: number;
  private readonly _cache: Map<string, { ts: number; labels: Set<string> }>;

  constructor(ttlSeconds = 300) {
    this.ttlMs = ttlSeconds * 1000;
    this._cache = new Map();
  }

  get(nwo: string): Set<string> | null {
    const entry = this._cache.get(nwo);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) {
      this._cache.delete(nwo);
      return null;
    }
    return entry.labels;
  }

  put(nwo: string, labels: Set<string>): void {
    this._cache.set(nwo, { ts: Date.now(), labels });
  }
}

function _fetchRepoLabels(nwo: string, ghBin = "gh"): Set<string> {
  /**
   * Call `gh label list --repo <nwo>`. Returns a set of label names.
   *
   * `ghBin` defaults to PATH-resolved "gh" (NOT an absolute path), so the check
   * works on Linux / Intel-mac / custom installs; the worker threads `cfg.ghBin`.
   * Returns empty set on any failure (timeout, gh not found, non-zero exit).
   * The checkLabelsExist function treats empty as "could not validate" and
   * emits a warning, not an error — better to let the ticket through than
   * to block on transient gh issues.
   */
  try {
    const stdout = execFileSync(
      ghBin,
      ["label", "list", "--repo", nwo, "--limit", "200", "--json", "name", "-q", ".[].name"],
      { encoding: "utf8", timeout: 30_000 },
    );
    const names = new Set<string>();
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) names.add(trimmed);
    }
    return names;
  } catch {
    return new Set<string>();
  }
}

function checkLabelsExist(
  frontmatter: Record<string, unknown>,
  repoNwo: string | null | undefined,
  opts: {
    labelCache?: LabelCache;
    fetchLabels?: (nwo: string) => Set<string>;
    ghBin?: string;
  } = {},
): LintViolation[] {
  const rawLabels = frontmatter["labels"];
  if (!Array.isArray(rawLabels) || rawLabels.length === 0) return [];

  if (!repoNwo) {
    return [
      {
        rule: "labels_exist",
        severity: "warning",
        message: "Cannot validate labels: no repo NWO available in frontmatter.",
      },
    ];
  }

  const cache = opts.labelCache ?? null;
  const ghBin = opts.ghBin ?? "gh";
  const fetchFn = opts.fetchLabels ?? ((nwo: string) => _fetchRepoLabels(nwo, ghBin));

  let repoLabels: Set<string>;
  const cached = cache ? cache.get(repoNwo) : null;
  if (cached === null) {
    repoLabels = fetchFn(repoNwo);
    if (cache && repoLabels.size > 0) {
      cache.put(repoNwo, repoLabels);
    }
  } else {
    repoLabels = cached;
  }

  if (repoLabels.size === 0) {
    return [
      {
        rule: "labels_exist",
        severity: "warning",
        message:
          `Could not fetch label list for ${repoNwo} ` +
          "(gh call failed or returned empty); skipping label validation.",
      },
    ];
  }

  const missing = rawLabels.map((lbl) => String(lbl)).filter((lbl) => !repoLabels.has(lbl));

  if (missing.length > 0) {
    return [
      {
        rule: "labels_exist",
        severity: "error",
        message:
          `Frontmatter labels not present on ${repoNwo}: ${JSON.stringify(missing)}. ` +
          `Available labels: ${JSON.stringify([...repoLabels].sort())}. ` +
          "Remove these or use existing labels — `gh pr create` will fail otherwise.",
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface LintTicketOpts {
  repoNwo?: string | null;
  repoPath?: string | null;
  checkLabels?: boolean;
  labelCache?: LabelCache;
  fetchLabels?: (nwo: string) => Set<string>;
  /** gh binary for the label-existence check; defaults to PATH-resolved "gh". */
  ghBin?: string;
}

export function lintTicket(
  body: string,
  frontmatter: Record<string, unknown>,
  opts: LintTicketOpts = {},
): LintResult {
  /**
   * Run all lint checks against a ticket body + frontmatter.
   *
   * Pass `checkLabels: false` to skip the network call to GitHub.
   * Pass `repoPath` (string) to enable filesystem-aware Files-table validation.
   */
  const { repoNwo, repoPath, checkLabels = true, labelCache, fetchLabels, ghBin } = opts;

  const violations: LintViolation[] = [];
  violations.push(...checkNoCdInVerification(body));
  violations.push(...checkStepsHaveCommits(body));
  violations.push(...checkFilesTableReferenced(body));
  violations.push(...checkFilesPathsExist(body, repoPath));
  violations.push(...checkNotesBlockPresent(body));
  violations.push(...checkNoForbiddenPhrases(body));
  violations.push(...checkNoCdInSteps(body));
  if (checkLabels) {
    violations.push(...checkLabelsExist(frontmatter, repoNwo, { labelCache, fetchLabels, ghBin }));
  }
  return new LintResult(violations);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatViolations(violations: LintViolation[]): string {
  /**
   * Multi-line summary of violations for logs / phase_error / PR bodies.
   * Python: "\n".join(f"[{v.severity}] {v.rule}: {v.message}" for v in violations)
   */
  return violations.map((v) => `[${v.severity}] ${v.rule}: ${v.message}`).join("\n");
}
