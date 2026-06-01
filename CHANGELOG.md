# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-31

### Added

- Daemon (`junco start`) with configurable poll loop, single-instance lock via PID file, orphan recovery on restart, and graceful SIGTERM/SIGINT shutdown.
- PR flow: per-ticket git worktree isolation, plan-lint gating (validates frontmatter + discipline rules before the agent runs), loop guards via the supervisor (per-kind budgets, escalation-window turn cap, per-turn and post-commit output budgets), `## Verification` bash-block runner (executed in the worktree after the agent session, results surfaced in the PR body), diff-vs-spec critic pass with one configurable corrective re-dispatch, `gh pr create` integration, and amend mode (`amends_pr`) for adding commits to existing PRs.
- Q&A ticket mode: tickets without a `repo:` field are answered in-place by the agent with no git operations.
- Embedded coding agent over any OpenAI-compatible inference endpoint (`[oMLX]` config section); agent driven via the `pi` SDK with a configurable tool allowlist and per-ticket timeout.
- Observability: `/live`, `/ready`, and `/health` HTTP endpoints; per-run metrics (turn count, output tokens, elapsed time); structured JSON logs; configurable log level (`debug` | `info` | `warn` | `error`).
- Dispatch CLI: `junco submit <ticket>` (enqueue a ticket), `junco inbox-path` (print the inbox directory), `junco schema` (print the ticket-frontmatter JSON Schema), `junco init` (scaffold `~/junco/config.toml`), `junco service` (render a launchd plist or systemd unit for the daemon).
- Typed ticket-frontmatter contract validated with Zod; all fields documented in the schema subcommand output.
- Harness-agnostic `junco-dispatch` Claude Code skill for scaffolding plan-lint-clean tickets from natural-language prompts.
- Service rendering for launchd (macOS) and systemd (Linux) via `junco service`.
