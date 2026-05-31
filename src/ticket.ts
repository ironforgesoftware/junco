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
      frontmatter = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
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
  const priority = (["low", "normal", "high"].includes(priorityRaw) ? priorityRaw : "normal") as Ticket["priority"];
  // Guard non-positive / non-finite timeouts (Python parity: timeout_minutes <= 0
  // was rejected). A zero timeout would abort the agent the instant it starts.
  const tmRaw = typeof frontmatter.timeout_minutes === "number" ? frontmatter.timeout_minutes : defaultTimeoutMinutes;
  const tm = Number.isFinite(tmRaw) && tmRaw > 0 ? tmRaw : defaultTimeoutMinutes;
  return {
    path, id, priority, timeoutSeconds: tm * 60, body, frontmatter,
    hasRepo: frontmatter.repo !== undefined && frontmatter.repo !== null,
  };
}
