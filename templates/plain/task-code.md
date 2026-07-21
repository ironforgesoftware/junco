---
id: my-code-task
priority: normal
timeout_minutes: 60
# PR-flow fields — presence of `repo:` triggers the git worktree + PR flow.
repo: ~/code/your-project
base_branch: main # optional, default from config
# branch_name: junco/custom-name   # optional, default junco/<id>
# draft: true                      # optional, default from config (draft)
# pr_title: "Custom PR title"      # optional, default = first H1 in body
# labels: [cleanup, auto]          # optional
# reviewers: [your-github-username] # optional
# tools: [read, grep, bash, edit, write]  # optional per-ticket tool override
---

# My code task

Describe the work here. The body is sent to the configured coding agent as the
prompt. The worker prepends a short preamble about the worktree, branch name,
base branch, and commit rules — you don't need to restate those.

## Verification

```bash
# Optional: bash blocks under a "## Verification" heading run in the worktree
# after the agent finishes; failures are surfaced in the PR body.
npm test
```
