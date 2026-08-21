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
      exclusiveMinimum: 0,
      description:
        "Maximum execution time in minutes. Defaults to the daemon's configured default_timeout_minutes. Must be strictly positive; non-positive values fall back to the default.",
    },
    base_branch: {
      type: "string",
      pattern: "^[A-Za-z0-9._/-]+$",
      description:
        "Base branch for the pull request. Defaults to the daemon's configured default_base_branch. Constrained to the git-ref charset so the value cannot smuggle a git option token.",
    },
    branch_name: {
      type: "string",
      pattern: "^[A-Za-z0-9._/-]+$",
      description:
        "Explicit name for the feature branch. Defaults to a generated slug from the ticket id. Constrained to the git-ref charset so the value cannot smuggle a git option token.",
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
      minimum: 1,
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
    network: {
      type: "boolean",
      description:
        "Sandbox egress opt-in for this ticket's agent session. Defaults to the configured `sandbox.network` policy (deny). Set true to allow network (e.g. installing a new dependency); only widens this one ticket.",
    },
    github: {
      type: "object",
      description:
        "Worker-managed: provenance of a ticket bridged from a GitHub issue. Do not set by hand — to request a linked issue on a local dispatch, see github_request.",
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
    github_request: {
      type: "object",
      description:
        "Dispatcher-settable request: ask the worker to create a GitHub tracking issue for this ticket at claim time and link the resulting pull request to it (the PR body gains `Closes owner/repo#N`, so merging closes the issue). The worker creates the issue on the clone's origin repo under its own gh identity (the bot account when configured) and then stamps the worker-managed `github:` provenance block itself — dispatchers never write `github:` by hand. Best-effort: if the issue cannot be created (offline, no permission, non-GitHub origin) the ticket still runs, unlinked. Ignored on fork-push tickets (`push_remote: fork`), on amend tickets (`amends_pr` — the existing PR body is never edited, so the issue could never auto-close), and on Q&A/assess/analyze tickets.",
      properties: {
        create_issue: {
          type: "boolean",
          description: "Set true to request tracking-issue creation.",
        },
      },
    },
    assess: {
      type: "object",
      description:
        "Presence of this mapping selects the assessment flavor: junco audits the repository named in `repo:` (read-only agent session plus a dependency scan) and parks the findings for review instead of opening a pull request — nothing is filed until a human confirms the batch (`junco assess review` then `junco assess file`). Authored by `junco assess`.",
      properties: {
        auto_plan: {
          type: "boolean",
          description:
            "Also apply the configured GitHub trigger label to each created issue, so the bridge plans it on its next sweep.",
        },
        issue: {
          type: "integer",
          minimum: 1,
          description:
            "Issue-scoped audit: the audit is steered to the code this issue implicates, and filed findings carry a Context reference to it. Set by `junco assess owner/repo#N`.",
        },
        issue_title: {
          type: "string",
          description: "The scoping issue's title (machine-built, display-only).",
        },
      },
    },
    analyze: {
      type: "object",
      description:
        "Presence of this mapping selects the analysis flavor: junco investigates the issue named here against the repository in `repo:` and parks a comment draft for review — it never posts without operator confirmation. Authored by `junco analyze`.",
      properties: {
        issue: { type: "integer", minimum: 1, description: "Issue number to investigate." },
        title: { type: "string", description: "Issue title, for display/logging." },
      },
    },
    depends_on: {
      type: "array",
      items: { type: "string" },
      description:
        "Ticket ids that must be satisfied before this ticket is claimed: each referenced ticket finished successfully AND (when it opened a pull request) that PR was merged. Unsatisfied edges leave the ticket queued; a terminally failed dependency parks this ticket in failed/ (dependency cascade).",
    },
    deps_satisfied: {
      type: "array",
      items: { type: "string" },
      description:
        "Worker-managed: depends_on entries the dependency sweep has confirmed satisfied. Do not set by hand.",
    },
    plan: {
      type: "object",
      description:
        "Optional plan-set membership/provenance: ties this ticket to an approved plan. `hash` is worker-managed (content hash of the approved plan).",
      properties: {
        id: { type: "string", description: "Plan-set identifier." },
        task: { type: "string", description: "Task id within the plan that produced this ticket." },
        hash: { type: "string", description: "Worker-managed: approved-plan content hash." },
      },
    },
  },
  required: [],
};

/** Return the schema as a formatted JSON string. */
export function describeTicketSchema(): string {
  return JSON.stringify(TICKET_FRONTMATTER_JSON_SCHEMA, null, 2);
}
