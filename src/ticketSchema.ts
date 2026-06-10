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
  },
  required: [],
};

/** Return the schema as a formatted JSON string. */
export function describeTicketSchema(): string {
  return JSON.stringify(TICKET_FRONTMATTER_JSON_SCHEMA, null, 2);
}
