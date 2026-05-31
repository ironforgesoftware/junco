import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Ticket } from "./types.js";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

export function parseTicket(path: string, raw: string, defaultTimeoutMinutes = 30): Ticket {
  let frontmatter: Record<string, unknown> = {};
  let body = raw;
  const m = FRONTMATTER_RE.exec(raw);
  if (m) {
    try { frontmatter = (parseYaml(m[1]) as Record<string, unknown>) ?? {}; }
    catch { frontmatter = {}; }
    body = m[2];
  }
  const fmId = typeof frontmatter.id === "string" ? frontmatter.id : undefined;
  const id = fmId ?? basename(path).replace(/\.md$/, "");
  const priorityRaw = String(frontmatter.priority ?? "normal");
  const priority = (["low", "normal", "high"].includes(priorityRaw) ? priorityRaw : "normal") as Ticket["priority"];
  const tm = typeof frontmatter.timeout_minutes === "number" ? frontmatter.timeout_minutes : defaultTimeoutMinutes;
  return {
    path, id, priority, timeoutSeconds: tm * 60, body, frontmatter,
    hasRepo: frontmatter.repo !== undefined && frontmatter.repo !== null,
  };
}
