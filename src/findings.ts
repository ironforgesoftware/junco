/**
 * `junco assess` finding schema, fingerprinting, sanitization, and the fenced
 * JSON extraction the agent's finalText carries findings in. Pure — no I/O,
 * no side effects. Later tasks (npm-audit mapping, issue rendering, the
 * orchestrator, the CLI) build on this module.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

export interface Finding {
  fingerprint: string;
  kind: "dependency" | "code";
  severity: Severity;
  ruleId: string;
  title: string;
  description: string;
  evidence?: string;
  remediation?: string;
  references: string[];
  package?: { name: string; range: string; fixedIn: string | null };
  location?: { path: string; line?: number };
}

// What the AGENT may supply. Deliberately does NOT accept a `fingerprint`
// field — junco always computes fingerprints itself (a model-chosen
// fingerprint could suppress a future real finding by colliding with it).
// z.object()'s default behavior strips unknown keys, which covers this;
// do NOT switch this to .passthrough().
//
// Cast rationale: zod's single-argument `z.ZodType<A>` pins both the
// pre-parse Input and post-parse Output to A, but this schema legitimately
// has an optional/defaulted Input (e.g. `description` may be omitted) and a
// required Output (`description: string` always, per Finding) — a real
// input/output split zod represents fine internally, just not through that
// one-argument spelling. The cast asserts the OUTPUT contract callers rely
// on (parsed `.data` is `Omit<Finding, "fingerprint">`); it changes no
// runtime behavior.
export const AgentFindingSchema = z.object({
  kind: z.enum(["dependency", "code"]),
  severity: z.enum(["critical", "high", "medium", "low"]),
  ruleId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  evidence: z.string().optional(),
  remediation: z.string().optional(),
  references: z.array(z.string()).default([]),
  package: z
    .object({
      name: z.string(),
      range: z.string(),
      fixedIn: z.string().nullable().default(null),
    })
    .optional(),
  location: z
    .object({
      path: z.string(),
      line: z.number().int().positive().optional(),
    })
    .optional(),
}) as z.ZodType<Omit<Finding, "fingerprint">>;

// Case-folded, punctuation-free, whitespace-collapsed title — the stable
// discriminator folded into a code finding's locus. Titles are the only
// required per-finding field (evidence and location.line are optional), and
// this normalization survives the casing/punctuation/backtick drift a model
// exhibits between runs while still separating genuinely distinct findings.
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// sha256 hex of `${kind}|${ruleId}|${locus}`, sliced to 16 chars. locus:
// package.name for package findings (exactly that — advisory identity is
// package x rule); `${location.path}#${normalizeTitle(title)}` for findings
// with a location (bare path collapsed two distinct findings in one file
// under one rule, and the state-all GitHub dedup then suppressed the
// survivor forever — issue #41); title otherwise. location.line is
// deliberately EXCLUDED so fingerprints survive line drift.
export function fingerprintFinding(
  f: Pick<Finding, "kind" | "ruleId" | "package" | "location" | "title">,
): string {
  const locus = f.package
    ? f.package.name
    : f.location
      ? `${f.location.path}#${normalizeTitle(f.title)}`
      : f.title;
  return createHash("sha256").update(`${f.kind}|${f.ruleId}|${locus}`).digest("hex").slice(0, 16);
}

// Complete `<!-- ... -->` comments are stripped; an unterminated `<!--` runs
// to end-of-string (lazy match against `-->` falls through to `$`).
const HTML_COMMENT_RE = /<!--[\s\S]*?(-->|$)/g;

// Control chars minus \t (\x09) and \n (\x0A); this range also covers \r
// (\x0D) and \x7F (DEL).
const CONTROL_CHAR_RE = /[\x00-\x08\x0B-\x1F\x7F]/g;

// Strips HTML comments (including an unterminated `<!--` to end-of-string),
// strips control chars except \n and \t (also strips \r), trims, and caps at
// `max` chars (append "…" when truncated).
export function sanitizeFindingText(s: string, max: number): string {
  const stripped = s.replace(HTML_COMMENT_RE, "").replace(CONTROL_CHAR_RE, "").trim();
  return stripped.length > max ? stripped.slice(0, max) + "…" : stripped;
}

export const FINDINGS_FENCE = "junco-findings";

// CommonMark fence-length-aware extraction of the LAST COMPLETE fenced block
// tagged `fence`: opening line /^(`{3,})\s*<fence>\s*$/, closed by a line of
// at least as many backticks (whitespace-trimmed). Returns the inner text, or
// null when no complete block exists. Mirrors extractPlanBody in
// src/githubInbox.ts:189-231 (implemented locally — that module owns the
// junco-ticket plan fence, this one owns junco-findings).
export function extractLastFencedBlock(text: string, fence: string): string | null {
  const lines = text.split("\n");
  const openRe = new RegExp("^(`{3,})\\s*" + fence + "\\s*$");
  let last: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = openRe.exec(lines[i]);
    if (!m) continue;
    const n = m[1].length;
    const closeRe = new RegExp("^`{" + n + ",}\\s*$");
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closeRe.test(lines[j])) {
        close = j;
        break;
      }
    }
    if (close === -1) continue; // no closer → not a complete block; ignore
    last = lines.slice(i + 1, close).join("\n");
    i = close; // resume scanning after this block's closer
  }
  return last;
}

const MAX_TITLE = 300;
const MAX_DESCRIPTION = 10_000;
const MAX_EVIDENCE = 5_000;
const MAX_REMEDIATION = 5_000;
const MAX_RULE_ID = 200;
const MAX_REFERENCE = 500;
const MAX_REFERENCES = 20;
const MAX_PACKAGE_FIELD = 300;
const MAX_LOCATION_PATH = 500;

// Extract the fence, JSON.parse it, require an array; per element: zod
// safeParse via AgentFindingSchema -> sanitize EVERY text field -> compute
// fingerprint -> collect. Invalid elements are dropped and counted. No
// fence / unparseable JSON / non-array => { findings: [], dropped: 0 }.
export function parseAgentFindings(text: string): { findings: Finding[]; dropped: number } {
  const fence = extractLastFencedBlock(text, FINDINGS_FENCE);
  if (fence === null) return { findings: [], dropped: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fence);
  } catch {
    return { findings: [], dropped: 0 };
  }
  if (!Array.isArray(parsed)) return { findings: [], dropped: 0 };

  const findings: Finding[] = [];
  let dropped = 0;
  for (const el of parsed) {
    const result = AgentFindingSchema.safeParse(el);
    if (!result.success) {
      dropped++;
      continue;
    }
    const f = result.data;
    const rest: Omit<Finding, "fingerprint"> = {
      kind: f.kind,
      severity: f.severity,
      ruleId: sanitizeFindingText(f.ruleId, MAX_RULE_ID),
      title: sanitizeFindingText(f.title, MAX_TITLE),
      description: sanitizeFindingText(f.description, MAX_DESCRIPTION),
      evidence:
        f.evidence === undefined ? undefined : sanitizeFindingText(f.evidence, MAX_EVIDENCE),
      remediation:
        f.remediation === undefined
          ? undefined
          : sanitizeFindingText(f.remediation, MAX_REMEDIATION),
      references: f.references
        .slice(0, MAX_REFERENCES)
        .map((r) => sanitizeFindingText(r, MAX_REFERENCE)),
      package: f.package
        ? {
            name: sanitizeFindingText(f.package.name, MAX_PACKAGE_FIELD),
            range: sanitizeFindingText(f.package.range, MAX_PACKAGE_FIELD),
            fixedIn:
              f.package.fixedIn === null
                ? null
                : sanitizeFindingText(f.package.fixedIn, MAX_PACKAGE_FIELD),
          }
        : undefined,
      location: f.location
        ? { path: sanitizeFindingText(f.location.path, MAX_LOCATION_PATH), line: f.location.line }
        : undefined,
    };
    findings.push({ fingerprint: fingerprintFinding(rest), ...rest });
  }
  return { findings, dropped };
}

export const FINDING_MARKER_PREFIX = "<!-- junco:finding:";

export function findingMarker(fp: string): string {
  return `${FINDING_MARKER_PREFIX}${fp} -->`;
}

const FINDING_MARKER_RE = /<!-- junco:finding:([0-9a-f]+) -->/g;

// Scan issue bodies for finding markers; return the set of fingerprints seen.
export function extractFindingMarkers(bodies: string[]): Set<string> {
  const out = new Set<string>();
  for (const body of bodies) {
    for (const m of body.matchAll(FINDING_MARKER_RE)) {
      out.add(m[1]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// npm audit -> findings
// ---------------------------------------------------------------------------

interface NpmAuditAdvisory {
  source?: number;
  name?: string;
  dependency?: string;
  title?: string;
  url?: string;
  severity?: string;
  cwe?: string[];
  range?: string;
}

interface NpmAuditFixAvailable {
  name: string;
  version: string;
  isSemVerMajor?: boolean;
}

interface NpmAuditVulnEntry {
  name?: string;
  severity?: string;
  isDirect?: boolean;
  via?: (string | NpmAuditAdvisory)[];
  range?: string;
  fixAvailable?: boolean | NpmAuditFixAvailable;
}

const NPM_SEVERITY_TO_OURS: Record<string, Severity> = {
  critical: "critical",
  high: "high",
  moderate: "medium",
  low: "low",
  info: "low",
};

function mapNpmSeverity(s: string | undefined): Severity {
  if (s === undefined) return "low";
  return NPM_SEVERITY_TO_OURS[s] ?? "low";
}

// https://github.com/advisories/GHSA-xxxx-yyyy-zzzz -> GHSA-xxxx-yyyy-zzzz
const GHSA_ID_RE = /GHSA-[0-9A-Za-z]+-[0-9A-Za-z]+-[0-9A-Za-z]+/;

/**
 * Map `npm audit --json` (npm >= 7 shape) output to Findings. Pure — the
 * caller owns running `npm audit` and passing its stdout in. Emits one
 * finding per (package, via-object) pair; a package whose `via` array is
 * entirely strings is transitive-only and is skipped (the parent advisory
 * that pulled it in already covers the root cause). npm's error shape
 * (`{ error: { code, summary, detail } }`) and malformed JSON both yield an
 * empty findings list plus a human-readable warning.
 */
export function findingsFromNpmAudit(stdoutJson: string): {
  findings: Finding[];
  warning: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdoutJson);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { findings: [], warning: `could not parse npm audit output: ${msg}` };
  }

  if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
    const err = (parsed as { error?: { summary?: string } }).error;
    return { findings: [], warning: err?.summary ?? "npm audit reported an error" };
  }

  const vulnerabilities =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { vulnerabilities?: unknown }).vulnerabilities
      : undefined;
  if (
    vulnerabilities === undefined ||
    typeof vulnerabilities !== "object" ||
    vulnerabilities === null
  ) {
    return { findings: [], warning: null };
  }

  const findings: Finding[] = [];
  for (const [rawPkgName, rawEntry] of Object.entries(
    vulnerabilities as Record<string, NpmAuditVulnEntry>,
  )) {
    // The npm-audit JSON object key, and every advisory/registry field below,
    // is external input (npm registry data, potentially poisoned) — sanitize
    // it the same way parseAgentFindings sanitizes agent-supplied fields
    // before it can reach a rendered issue body or the embedded JSON block.
    const pkgName = sanitizeFindingText(rawPkgName, MAX_PACKAGE_FIELD);
    const entry = rawEntry ?? {};
    const via = entry.via ?? [];
    const advisories = via.filter(
      (v): v is NpmAuditAdvisory => typeof v === "object" && v !== null,
    );
    if (advisories.length === 0) continue; // transitive-only package

    for (const advisory of advisories) {
      const rawTitle = advisory.title ?? "(untitled advisory)";
      const title = sanitizeFindingText(rawTitle, MAX_TITLE);
      const ghsaMatch = advisory.url ? GHSA_ID_RE.exec(advisory.url) : null;
      const ruleId = ghsaMatch ? ghsaMatch[0] : sanitizeFindingText(rawTitle, MAX_RULE_ID);
      const severity = mapNpmSeverity(advisory.severity);
      const range = sanitizeFindingText(advisory.range ?? entry.range ?? "", MAX_PACKAGE_FIELD);
      const description = sanitizeFindingText(
        `${pkgName} ${range} is vulnerable: ${title}`,
        MAX_DESCRIPTION,
      );

      const fixAvailable = entry.fixAvailable;
      let fixedIn: string | null = null;
      let remediation: string;
      if (fixAvailable !== null && typeof fixAvailable === "object") {
        const fixName =
          typeof fixAvailable.name === "string"
            ? sanitizeFindingText(fixAvailable.name, MAX_PACKAGE_FIELD)
            : pkgName;
        // A non-string version (malformed/poisoned registry data) coerces to
        // a null fixedIn — never undefined, which would silently vanish from
        // the embedded JSON block and break its round-trip.
        const fixVersion =
          typeof fixAvailable.version === "string"
            ? sanitizeFindingText(fixAvailable.version, MAX_PACKAGE_FIELD)
            : null;
        fixedIn = fixVersion;
        remediation = `Upgrade ${fixName} to ${fixVersion ?? "a fixed version"}${
          fixAvailable.isSemVerMajor ? " (semver-major)" : ""
        }.`;
      } else if (fixAvailable === true) {
        remediation = "Fix available via `npm audit fix`.";
      } else {
        remediation = "No fix available yet.";
      }

      const reference = advisory.url ? sanitizeFindingText(advisory.url, MAX_REFERENCE) : null;

      const rest: Omit<Finding, "fingerprint"> = {
        kind: "dependency",
        severity,
        ruleId,
        title,
        description,
        remediation,
        references: reference ? [reference] : [],
        package: { name: pkgName, range, fixedIn },
      };
      findings.push({ fingerprint: fingerprintFinding(rest), ...rest });
    }
  }

  return { findings, warning: null };
}

// ---------------------------------------------------------------------------
// GitHub issue rendering
// ---------------------------------------------------------------------------

const MAX_ISSUE_TITLE_TEXT = 120;

// "[<severity>] <title> (<ruleId>)" — the title portion is flattened to one
// line (each newline becomes a single space) and capped at 120 chars with a
// trailing ellipsis when cut, mirroring sanitizeFindingText's cap style.
export function buildIssueTitle(f: Finding): string {
  const flat = f.title.replace(/\n/g, " ");
  const capped =
    flat.length > MAX_ISSUE_TITLE_TEXT ? flat.slice(0, MAX_ISSUE_TITLE_TEXT) + "…" : flat;
  return `[${f.severity}] ${capped} (${f.ruleId})`;
}

// GitHub's true issue-body cap is 65,536 chars; stay under 60,000 for
// headroom (mirrors COMMENT_LIMIT in src/githubInbox.ts — kept as its own
// local constant rather than importing across modules for one shared
// number).
const ISSUE_BODY_LIMIT = 60_000;
const TRUNCATED_DESCRIPTION_CAP = 2_000;

// Longest run of consecutive backticks at the START of any line in `text`.
// Local copy of the identically-named helper in src/githubInbox.ts:172
// (buildPlanComment's dynamic-fence precedent) — mirrored rather than
// imported to keep this module import-cycle-free and I/O-free, same
// rationale as extractLastFencedBlock above.
function longestBacktickRun(text: string): number {
  let max = 0;
  for (const line of text.split("\n")) {
    const m = /^(`+)/.exec(line);
    if (m && m[1].length > max) max = m[1].length;
  }
  return max;
}

function renderIssueBody(f: Finding, truncated: boolean): string {
  const sections: string[] = [];

  if (f.description) {
    sections.push(`## Summary\n\n${f.description}`);
  }

  if (f.kind === "dependency" && f.package) {
    const fixedIn = f.package.fixedIn ?? "no fix available yet";
    sections.push(
      `## Package\n\n**Name:** ${f.package.name}\n**Vulnerable range:** ${f.package.range}\n**Fixed in:** ${fixedIn}`,
    );
  }

  if (f.kind === "code" && f.location) {
    const loc =
      f.location.line !== undefined ? `${f.location.path}:${f.location.line}` : f.location.path;
    sections.push(`## Location\n\n\`${loc}\``);
  }

  if (f.evidence) {
    sections.push(`## Evidence\n\n${f.evidence}`);
  }

  if (f.remediation) {
    sections.push(`## Remediation\n\n${f.remediation}`);
  }

  if (f.references.length > 0) {
    sections.push(`## References\n\n${f.references.map((r) => `- ${r}`).join("\n")}`);
  }

  // Dynamic fence: JSON.stringify does not escape backticks, so a description
  // containing ``` could close a fixed 3-backtick fence early (the
  // buildPlanComment lesson, src/githubInbox.ts:227).
  const json = JSON.stringify(f, null, 2);
  const fence = "`".repeat(Math.max(4, longestBacktickRun(json) + 1));
  sections.push(
    `<details><summary>machine-readable</summary>\n\n${fence}json\n${json}\n${fence}\n\n</details>`,
  );

  if (truncated) {
    sections.push("_(sections truncated to fit)_");
  }

  // The marker MUST be the literal last line, outside every fence.
  sections.push(findingMarker(f.fingerprint));

  return sections.join("\n\n");
}

// Human sections + machine-readable JSON block + finding marker (see
// findingMarker). Round-trips via extractLastFencedBlock(body, "json") +
// JSON.parse. When the full render would exceed GitHub's practical cap, it
// is re-rendered once with a reduced finding (description re-capped to
// 2_000 chars, evidence omitted) in both the human sections and the
// embedded JSON, with a truncation notice appended before the marker.
export function buildIssueBody(f: Finding): string {
  const full = renderIssueBody(f, false);
  if (full.length <= ISSUE_BODY_LIMIT) return full;

  const reduced: Finding = {
    ...f,
    description:
      f.description.length > TRUNCATED_DESCRIPTION_CAP
        ? f.description.slice(0, TRUNCATED_DESCRIPTION_CAP) + "…"
        : f.description,
    evidence: undefined,
  };
  return renderIssueBody(reduced, true);
}

// The label every junco-filed finding issue carries — also the dedup filter
// the outbox flush executor's `gh issue list --label` scan uses (see
// ensureFindingLabels/execute's "issue-create" case in src/githubOutbox.ts).
export const FINDING_LABEL = "junco:finding";

// [name, color, description] specs for the labels junco creates when filing
// findings — mirrors LABEL_SPECS in src/githubInbox.ts (that module owns the
// lifecycle labels, this one owns the finding labels).
export const FINDING_LABEL_SPECS: ReadonlyArray<readonly [string, string, string]> = [
  [FINDING_LABEL, "1D76DB", "Filed by junco assess"],
  ["severity/critical", "B60205", "Finding severity: critical"],
  ["severity/high", "D93F0B", "Finding severity: high"],
  ["severity/medium", "FBCA04", "Finding severity: medium"],
  ["severity/low", "0E8A16", "Finding severity: low"],
];

// [FINDING_LABEL, "severity/<level>"] plus the trigger label appended when
// opts.autoPlan is set — the created issue then enters the bridge's existing
// plan-comment loop the same as any manually-triggered issue.
export function findingLabels(
  f: Finding,
  opts: { autoPlan: boolean; triggerLabel: string },
): string[] {
  const labels = [FINDING_LABEL, `severity/${f.severity}`];
  if (opts.autoPlan) labels.push(opts.triggerLabel);
  return labels;
}
