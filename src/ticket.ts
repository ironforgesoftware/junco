import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Ticket } from "./types.js";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

export function parseTicket(path: string, raw: string, defaultTimeoutMinutes = 30): Ticket {
  let frontmatter: Record<string, unknown> = {};
  let body = raw;
  const m = FRONTMATTER_RE.exec(raw);
  if (m) {
    try {
      // Only a YAML mapping counts as frontmatter; a scalar/array/null is
      // treated as "no frontmatter" rather than masquerading as a record.
      const parsed = parseYaml(m[1]);
      frontmatter =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      frontmatter = {};
    }
    body = m[2];
  }
  const fmId = typeof frontmatter.id === "string" ? frontmatter.id : undefined;
  const id = fmId ?? basename(path).replace(/\.md$/, "");
  const priorityRaw = String(frontmatter.priority ?? "normal").toLowerCase();
  const priority = (
    ["low", "normal", "high"].includes(priorityRaw) ? priorityRaw : "normal"
  ) as Ticket["priority"];
  // Guard non-positive / non-finite timeouts (Python parity: timeout_minutes <= 0
  // was rejected). A zero timeout would abort the agent the instant it starts.
  const tmRaw =
    typeof frontmatter.timeout_minutes === "number"
      ? frontmatter.timeout_minutes
      : defaultTimeoutMinutes;
  const tm = Number.isFinite(tmRaw) && tmRaw > 0 ? tmRaw : defaultTimeoutMinutes;
  const ghRaw = frontmatter.github;
  let github: Ticket["github"] = null;
  if (ghRaw !== null && typeof ghRaw === "object" && !Array.isArray(ghRaw)) {
    const g = ghRaw as Record<string, unknown>;
    if (
      typeof g.nwo === "string" &&
      typeof g.issue === "number" &&
      Number.isInteger(g.issue) &&
      g.issue > 0 &&
      (g.kind === "pr" || g.kind === "ask" || g.kind === "plan")
    ) {
      github = { nwo: g.nwo, issue: g.issue, kind: g.kind, external: g.external === true };
    }
  }
  const assessRaw = frontmatter.assess;
  let assess: Ticket["assess"] = null;
  if (assessRaw !== null && typeof assessRaw === "object" && !Array.isArray(assessRaw)) {
    const a = assessRaw as Record<string, unknown>;
    assess = { autoPlan: a.auto_plan === true };
  }
  const analyzeRaw = frontmatter.analyze;
  let analyze: Ticket["analyze"] = null;
  if (analyzeRaw !== null && typeof analyzeRaw === "object" && !Array.isArray(analyzeRaw)) {
    const a = analyzeRaw as Record<string, unknown>;
    if (typeof a.issue === "number" && Number.isInteger(a.issue)) {
      analyze = { issue: a.issue, title: String(a.title ?? "") };
    }
  }
  return {
    path,
    id,
    priority,
    timeoutSeconds: tm * 60,
    body,
    frontmatter,
    hasRepo: frontmatter.repo !== undefined && frontmatter.repo !== null,
    notBefore: typeof frontmatter.not_before === "string" ? frontmatter.not_before : null,
    retryCount:
      typeof frontmatter.retry_count === "number" &&
      Number.isInteger(frontmatter.retry_count) &&
      frontmatter.retry_count >= 0
        ? frontmatter.retry_count
        : 0,
    tools: Array.isArray(frontmatter.tools)
      ? frontmatter.tools.filter((t): t is string => typeof t === "string" && t.trim() !== "")
      : null,
    github,
    assess,
    analyze,
    workdir:
      typeof frontmatter.workdir === "string" && frontmatter.workdir.trim() !== ""
        ? frontmatter.workdir
        : null,
  };
}
