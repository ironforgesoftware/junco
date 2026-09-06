/**
 * Pre-push secret scan (#337).
 *
 * `sandbox.network: deny` governs the AGENT's tool calls. It is never consulted
 * when junco itself commits the worktree and pushes it under the bot identity —
 * so the push is an egress channel the sandbox does not see. This module scans
 * the ADDED lines of the diff about to be pushed (`<sinceRef>..HEAD`) for a
 * short list of high-confidence secret shapes; prFlow refuses the push on a hit.
 *
 * Reporting discipline: a finding carries the path, the post-image line number
 * and the rule NAME — never the matched text, and never the line it came from.
 * The failure note, the log line and the ticket record all go through
 * `formatSecretFindings`, so a blocked secret is never copied into `failed/`,
 * the worker log, or a PR comment.
 *
 * The rule set is deliberately narrow: shapes with a fixed prefix and a
 * token-length body, where a match is almost never a false positive. Broad
 * heuristics (entropy, `password =`) belong in a dedicated scanner, not in a
 * gate that fails a ticket.
 */

import { git } from "./git.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecretFinding {
  /** Path as the diff names it, with the `b/` destination prefix stripped. */
  path: string;
  /** 1-based line number in the post-image of that file. */
  line: number;
  /** The shape that matched — a rule name, never the matched text. */
  rule: string;
}

/** Returns the unified diff of `sinceRef..HEAD` in `wtPath`. */
type DiffProvider = (cfg: { gitBin: string }, wtPath: string, sinceRef: string) => Promise<string>;

/** Injectable seams for scanPendingPush (tests inject the diff provider). */
export interface SecretScanDeps {
  diffProvider?: DiffProvider;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface SecretRule {
  name: string;
  re: RegExp;
}

/**
 * Every pattern is written so its own source text cannot match it (each prefix
 * is followed by a character class, never by a literal body) — this file is
 * itself pushed by junco.
 */
const RULES: readonly SecretRule[] = [
  { name: "pem-private-key", re: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/ },
  {
    name: "github-token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  },
  { name: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "anthropic-api-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: "stripe-live-key", re: /\bsk[_-]live[_-][A-Za-z0-9]{16,}/ },
  { name: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}/ },
  // Credentials embedded in a URL — the shape a leaked .netrc / .npmrc / git
  // remote takes once it is copied into a source file. Written without a
  // scheme in this comment so the line itself stays clean: `://user:pass@host`.
  { name: "url-credentials", re: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/ },
] as const;

/** Findings named individually in a failure note; the rest are counted. */
const MAX_REPORTED_FINDINGS = 10;

// ---------------------------------------------------------------------------
// Diff scanning
// ---------------------------------------------------------------------------

/** `+++ b/src/a.ts` → `src/a.ts`; `+++ /dev/null` (a deletion) → null. */
function destPath(header: string): string | null {
  // git appends no timestamp, but a `--no-prefix`/`--dst-prefix` diff can still
  // vary — take everything up to a tab, then drop a one-letter `x/` prefix.
  const raw = header.slice(4).split("\t")[0].trim();
  if (raw === "/dev/null") return null;
  return /^[a-z]\//.test(raw) ? raw.slice(2) : raw;
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)/;

/**
 * Scan the added lines of a unified diff. Walks hunk headers to keep a
 * post-image line counter, so a finding names the line number a reviewer sees
 * in the file — not an offset into the diff.
 */
export function scanDiffForSecrets(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let path: string | null = null;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    // `+++ ` before the `+` branch: the header is not an added line.
    if (line.startsWith("+++ ")) {
      path = destPath(line);
      newLine = 0;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      path = null;
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("@@")) {
      const m = HUNK_RE.exec(line);
      if (m) newLine = parseInt(m[1], 10);
      continue;
    }
    if (path === null) continue;
    if (line.startsWith("+")) {
      const content = line.slice(1);
      const rule = RULES.find((r) => r.re.test(content));
      if (rule) findings.push({ path, line: newLine, rule: rule.name });
      newLine++;
      continue;
    }
    // "\ No newline at end of file" belongs to the preceding line; removed
    // lines are not in the post-image. Neither advances the counter.
    if (line.startsWith("-") || line.startsWith("\\")) continue;
    if (line.startsWith(" ")) newLine++;
  }

  return findings;
}

// ---------------------------------------------------------------------------
// scanPendingPush
// ---------------------------------------------------------------------------

/**
 * `git diff <sinceRef>..HEAD` with zero context — the added lines are all the
 * scan needs, and dropping context keeps a large branch cheap to read.
 * `check:false` (plus `--no-ext-diff`, so a repo's own diff driver cannot shape
 * the output) means a git hiccup yields an empty diff rather than throwing.
 */
const gitDiffProvider: DiffProvider = async (cfg, wtPath, sinceRef) => {
  const cp = await git(cfg, ["diff", "--unified=0", "--no-ext-diff", `${sinceRef}..HEAD`], {
    cwd: wtPath,
    timeoutMs: 30_000,
    check: false,
  });
  return cp.stdout || "";
};

/** Findings in the diff `wtPath` is about to push (`sinceRef..HEAD`). */
export async function scanPendingPush(
  cfg: { gitBin: string },
  wtPath: string,
  sinceRef: string,
  deps: SecretScanDeps = {},
): Promise<SecretFinding[]> {
  const diff = await (deps.diffProvider ?? gitDiffProvider)(cfg, wtPath, sinceRef);
  return scanDiffForSecrets(diff);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** The one place findings become text. Path + line + rule name, nothing else. */
export function formatSecretFindings(findings: SecretFinding[]): string {
  const shown = findings.slice(0, MAX_REPORTED_FINDINGS);
  const list = shown.map((f) => `${f.path}:${f.line} (${f.rule})`).join(", ");
  const more = findings.length > shown.length ? `, +${findings.length - shown.length} more` : "";
  return `${findings.length} ${findings.length === 1 ? "match" : "matches"} — ${list}${more}`;
}
