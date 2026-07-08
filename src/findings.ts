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

// sha256 hex of `${kind}|${ruleId}|${locus}`, sliced to 16 chars. locus
// precedence: package?.name ?? location?.path ?? title. location.line is
// deliberately EXCLUDED so fingerprints survive line drift.
export function fingerprintFinding(
  f: Pick<Finding, "kind" | "ruleId" | "package" | "location" | "title">,
): string {
  const locus = f.package?.name ?? f.location?.path ?? f.title;
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
