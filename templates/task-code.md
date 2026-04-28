---
id: <% tp.date.now("YYYY-MM-DD-HHmm") %>-<% tp.file.title %>
created: <% tp.date.now("YYYY-MM-DDTHH:mm:ss") %>
priority: normal
timeout_minutes: 60
# PR-flow fields — presence of `repo:` triggers the git worktree + PR flow.
repo: ~/Development/your-project
base_branch: main           # optional, default from config
# branch_name: junco/custom-name  # optional, default junco/<id>
# draft: true                     # optional, default from config (draft)
# pr_title: "Custom PR title"     # optional, default = first H1 in body
# labels: [cleanup, auto]         # optional
# reviewers: [ironforgesoftware]       # optional
---

# <% tp.file.title %>

Describe the work here. The body is piped to the configured agent (`pi` or `omp`) as the prompt. The worker
prepends a short preamble telling the agent about the worktree, branch name,
base branch, and commit rules — you don't need to restate those.

Wikilinks like [[Some Other Note]] pass through unchanged. Absolute file
paths work fine; relative paths are resolved against the worktree.

Leave the `pr_title` empty to use the first H1 above as the PR title.
