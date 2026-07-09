/**
 * Junco ticket frontmatter — typed JSON Schema contract (draft 2020-12).
 *
 * Stack-agnostic: describes the dispatch contract; the execution engine is
 * invisible to the dispatcher.
 */

export const TICKET_FRONTMATTER_JSON_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Junco ticket frontmatter",
  type: "object",
  description:
    "YAML frontmatter block that appears between --- delimiters at the top of a Junco ticket Markdown file.",
  properties: {
    id: {
      type: "string",
      description: "Unique ticket identifier. Defaults to the filename (without .md) when omitted.",
    },
    repo: {
      type: "string",
      description:
        "Absolute path to the target git repo; presence makes this a PR-flow ticket, absence a Q&A ticket.",
    },
    priority: {
      type: "string",
      enum: ["low", "normal", "high"],
      description: "Scheduling priority. Defaults to normal.",
    },
    timeout_minutes: {
      type: "number",
      description:
        "Maximum execution time in minutes. Defaults to the daemon's configured default_timeout_minutes.",
    },
    base_branch: {
      type: "string",
      description:
        "Base branch for the pull request. Defaults to the daemon's configured default_base_branch.",
    },
    branch_name: {
      type: "string",
      description:
        "Explicit name for the feature branch. Defaults to a generated slug from the ticket id.",
    },
    pr_title: {
      type: "string",
      description:
        "Pull request title. Defaults to the first H1 heading in the ticket body, or the ticket id.",
    },
    draft: {
      type: "boolean",
      description:
        "Open the pull request as a draft. Defaults to the daemon's configured draft_by_default.",
    },
    labels: {
      type: "array",
      items: { type: "string" },
      description:
        "Labels to apply to the pull request. Merged with the daemon's configured default_labels.",
    },
    reviewers: {
      type: "array",
      items: { type: "string" },
      description: "GitHub handles to request as pull request reviewers.",
    },
    amends_pr: {
      type: "number",
      description:
        "Pull request number to amend (push additional commits to) instead of opening a new PR.",
    },
    push_remote: {
      type: "string",
      pattern: "^[A-Za-z0-9_-]+$",
      description:
        "Git remote the PR flow pushes the feature branch to. Defaults to origin. Set to fork (with a fork remote configured on the clone) for fork-based PRs against repos the operator cannot push to; gh pr create then uses --head <fork-owner>:<branch>.",
    },
    not_before: {
      type: "string",
      format: "date-time",
      description:
        "Do not claim this ticket before this UTC instant (ISO 8601). The worker sets this for retry backoff; dispatchers may also set it to schedule work.",
    },
    retry_count: {
      type: "integer",
      minimum: 0,
      description:
        "Worker-managed: how many transparent requeue attempts this ticket has consumed. Do not set by hand.",
    },
    tools: {
      type: "array",
      items: { type: "string" },
      description:
        "Tool allowlist override for this ticket's agent session. Q&A tickets default to a read-only subset (read, grep, find, ls); list tools explicitly (e.g. [read, grep, bash]) to opt in to more.",
    },
    workdir: {
      type: "string",
      description:
        "Q&A tickets only: directory the session runs in (read-only tools). Defaults to the worker's processing directory.",
    },
    github: {
      type: "object",
      description:
        "Worker-managed: provenance of a ticket bridged from a GitHub issue. Do not set by hand.",
      properties: {
        nwo: { type: "string", description: "Repository name-with-owner, e.g. acme/api." },
        issue: { type: "integer", minimum: 1, description: "Source issue number." },
        kind: { type: "string", enum: ["pr", "ask", "plan"], description: "Execution path." },
        external: {
          type: "boolean",
          description:
            "Worker-managed: true when the ticket targets a repo the operator does not control. The reporter posts no labels/comments to the upstream issue; the PR itself (from the push_remote fork) is the only outward-facing write.",
        },
      },
    },
    assess: {
      type: "object",
      description:
        "Presence of this mapping selects the assessment flavor: junco audits the repository named in `repo:` (read-only agent session plus a dependency scan) and files one GitHub issue per vulnerability finding, instead of opening a pull request. Authored by `junco assess`.",
      properties: {
        auto_plan: {
          type: "boolean",
          description:
            "Also apply the configured GitHub trigger label to each created issue, so the bridge plans it on its next sweep.",
        },
      },
    },
  },
  required: [],
};

/** Return the schema as a formatted JSON string. */
export function describeTicketSchema(): string {
  return JSON.stringify(TICKET_FRONTMATTER_JSON_SCHEMA, null, 2);
}
