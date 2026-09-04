import type { PendingDraft } from "./draftStore.js";

/** One argv per CLI invocation, in order (spec §6.1 table, §6.4 override).
 * audit/investigate replay the argv derived at park time; every other kind
 * submits the file on disk, so the CLI does the routing and identity handling
 * exactly as it does for the skill. */
export function submitArgv(d: PendingDraft, filePath: (name: string) => string): string[][] {
  if (d.kind === "audit" || d.kind === "investigate") return d.commandArgs ? [d.commandArgs] : [];
  const asIssue = (f: PendingDraft["files"][number]): boolean =>
    d.routeOverride === "issue" || (d.routeOverride === "auto" && f.route?.destination === "issue");
  if (d.kind === "planSet") {
    const f = d.files[0]!;
    return [
      [
        "submit",
        ...(asIssue(f) ? ["--as-issue"] : []),
        "--plan",
        filePath(f.name),
        "--repo",
        d.cwd,
      ],
    ];
  }
  return d.files.map((f) => ["submit", ...(asIssue(f) ? ["--as-issue"] : []), filePath(f.name)]);
}

/** The ticket ids a draft carries — its file stems; what the card and the
 * `junco_chat_draft`/`junco_chat_command` records show as `ids`. */
export function draftTicketIds(d: PendingDraft): string[] {
  return d.files.map((f) => f.name.replace(/\.md$/, ""));
}
