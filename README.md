# junco

_A local-first worker that turns tickets into pull requests._

[![npm](https://img.shields.io/npm/v/%40ironforgesoftware%2Fjunco)](https://www.npmjs.com/package/@ironforgesoftware/junco)
[![CI](https://github.com/ironforgesoftware/junco/actions/workflows/test.yml/badge.svg)](https://github.com/ironforgesoftware/junco/actions/workflows/test.yml)
[![node](https://img.shields.io/node/v/%40ironforgesoftware%2Fjunco)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/%40ironforgesoftware%2Fjunco)](LICENSE)

Junco is a daemon that runs on your machine, picks up Markdown tickets from a
folder — or GitHub issues you label — plans the work, waits for your approval,
then executes it with a supervised coding agent and opens the pull request.
It drives the agent against any **OpenAI-compatible inference endpoint** you
point it at: your code, your git, and your credentials stay in a loop you
control. Any tool or human can author tickets; junco is harness-agnostic on
the dispatch side.

```text
 🐦 junco  acme/reef-api      ●2 review · ✓14 · last ✓ 4m · daemon ● up 6h · ◐1 ⏳2
╭ 1 repos ───────────╮╭ 2 issues · 14 ─────────────────────╮╭ 3 preview ───────────────╮
│▌acme/reef-api  2●  ││▌● #52 Fix reef color…   plan-ready ││ #52 Fix reef color       │
│ acme/tide-cli      ││ ◐ #46 Bleaching alert      working ││ grading [plan-ready]     │
│────────────────────││ ○ #61 Add tide tables          3h  ││                          │
│ queue              ││ ✓ #44 Coral survey       done  2d  ││ The grading LUT clips    │
│ ◐ #46 · turn 14    ││                                    ││ at shallow-water bands…  │
│ 2 waiting          ││                             2/14   ││ ── plan ──               │
╰────────────────────╯╰────────────────────────────────────╯╰──────────────────────────╯
 ↑/↓ move · ←/→ panes · enter preview · d dispatch · a approve · / filter · ? help
```

## Why junco

- **Tickets in, pull requests out** — a ticket is a Markdown file with a small
  YAML header. Junco claims it, works in an isolated git worktree, verifies
  the result, runs a diff-vs-spec critic, and opens a draft PR. Tickets
  without a `repo:` are Q&A: answered in place, read-only, no git involved.
- **GitHub-native dispatch** — label an issue `junco` and junco plans the
  work in an issue comment; **approve with a label** and the PR follows,
  closing the issue on merge.
- **Plans before code** — the plan is an editable comment on the issue, and
  nothing executes until an approval that junco verifies (who applied it,
  and that it came _after_ the plan).
- **Local-first by design** — your machine, your git, your `gh` auth, your
  choice of inference endpoint. There is no third service in the loop.
- **Offline-tolerant** — when GitHub is unreachable, an outbox queues the
  comments, labels, and PR pushes durably and drains itself on reconnect.
  The queue keeps working; finished work is never lost to a dead network.
- **A dashboard worth living in** — a fullscreen terminal UI for the whole
  loop: watch repos, read plans, approve, track the queue, track your open
  PRs, and run any junco command from a palette without leaving it.
- **Supervised, not hopeful** — loop guards catch stuck agents, timeouts
  salvage the commits already made, transient failures retry with backoff,
  and every run leaves a full transcript.

## Sixty seconds to a running worker

Requires **Node ≥ 22.19**, plus `git` and an authenticated `gh` for PR flows.

```bash
npx @ironforgesoftware/junco   # first run → setup wizard; afterwards → starts the daemon
```

The wizard asks a few questions, detects the models on your endpoint, writes
`config.toml`, and creates the queue. (Prefer a global install:
`npm install -g @ironforgesoftware/junco`, then the command is just `junco`.
`junco init --yes` scaffolds defaults non-interactively.)

```bash
junco start                    # poll the inbox; Ctrl-C to stop
junco submit my-task.md        # give it work — with a repo: field it opens a PR
junco dashboard                # or drive everything from the TUI
```

New to the ticket format? `junco schema` prints it, `examples/` has
templates, and the bundled **junco-dispatch** skill teaches coding agents to
write well-formed tickets for you.

## Two ways to feed it

**From a folder.** Drop Markdown tickets into the inbox (`junco submit`, or
any tool writing files). Each runs through a 14-phase pipeline: worktree →
agent → verification → critic → draft PR, with requeue-and-backoff on
transient failures. → [Tickets guide](docs/tickets.md)

**From GitHub.** Watch repos in `config.toml` or from the dashboard. Label an
issue `junco` → a plan appears as a comment → apply `junco:approved` → the PR
arrives with a `Closes #N`. Lifecycle labels track every step, and the trust
model is explicit about who can approve what.
→ [GitHub mode guide](docs/github-mode.md)

## Documentation

| Guide                                      | What's inside                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| [Tickets](docs/tickets.md)                 | Ticket flavors, frontmatter reference, examples, submission, the PR-flow lifecycle   |
| [Configuration](docs/configuration.md)     | The annotated `config.toml` reference and the knobs worth knowing                    |
| [GitHub mode](docs/github-mode.md)         | Setup, the plan → approve → PR loop, lifecycle labels, offline behavior, trust model |
| [Vulnerability assessment](docs/assess.md) | `junco assess` — audit a repo, file GitHub issues, dedup semantics, `--auto-plan`    |
| [Dashboard](docs/dashboard.md)             | Every pane, key, and the command palette                                             |
| [Operations](docs/operations.md)           | Health endpoint, running as a service, security model, troubleshooting               |
| [ARCHITECTURE.md](ARCHITECTURE.md)         | The runtime, module by module — accurate and maintained                              |

## CLI at a glance

|                                                 |                                                         |
| ----------------------------------------------- | ------------------------------------------------------- |
| `junco start` / `junco restart`                 | run the daemon / restart the installed service          |
| `junco submit <file>`                           | queue a ticket (also reads stdin)                       |
| `junco dashboard`                               | the fullscreen TUI                                      |
| `junco status` / `junco list` / `junco logs -f` | daemon, queue, and log visibility                       |
| `junco prs`                                     | list junco-authored pull requests across watched repos  |
| `junco assess <path\|owner/repo> [--auto-plan]` | audit a repo for vulnerabilities and file GitHub issues |
| `junco retry <name…\|--all>`                    | move failed tickets back to the inbox                   |
| `junco outbox [flush]`                          | inspect or push the offline GitHub backlog              |
| `junco doctor`                                  | preflight config, git/gh auth, endpoint, model          |
| `junco init` / `junco schema` / `junco service` | wizard, ticket schema, service install                  |

## Contributing

Contributions are welcome — junco is young, and the codebase is still small
enough to hold in your head.

```bash
git clone https://github.com/ironforgesoftware/junco && cd junco
npm install
npm test          # vitest, ~1,100 tests, a few seconds
```

- Run the full gate before a PR:
  `npm run lint && npm run format:check && npm run build && npm test`
- Development is test-first with a commit per unit of work; the suite is
  green at every commit. Conventional commit messages (`feat:`, `fix:`, …).
- [ARCHITECTURE.md](ARCHITECTURE.md) is accurate and maintained — read it
  before touching the runtime, and keep it true when you do.
- For features, open an issue first — plans are cheap, rework isn't.

The longer version — conventions, testing expectations, commit and PR
policy — lives in [CONTRIBUTING.md](CONTRIBUTING.md). And junco can submit
tickets against itself — drop a PR-flow ticket with `repo:` pointing at this
repository.

## License

[MIT](LICENSE)
