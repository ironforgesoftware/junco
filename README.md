# junco

_Issues in. Pull requests out._

[![npm](https://img.shields.io/npm/v/%40ironforgesoftware%2Fjunco)](https://www.npmjs.com/package/@ironforgesoftware/junco)
[![CI](https://github.com/ironforgesoftware/junco/actions/workflows/quality-gate.yml/badge.svg)](https://github.com/ironforgesoftware/junco/actions/workflows/quality-gate.yml)
[![node](https://img.shields.io/node/v/%40ironforgesoftware%2Fjunco)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/%40ironforgesoftware%2Fjunco)](LICENSE)

**[junco.ironforgesoftware.com](https://junco.ironforgesoftware.com)** — the one-page tour.

Junco is a daemon that runs on your machine. Label a GitHub issue `junco` and it
plans the work as an issue comment; approve with a label, and it executes with a
supervised coding agent in an isolated git worktree and opens the pull request —
all watched from a fullscreen terminal dashboard. It drives the agent against any
**OpenAI-compatible inference endpoint** you point it at — or a hosted provider
from the embedded catalog. Your code, your git, and your credentials stay in a
loop you control. The other door is a folder: Markdown
tickets with a small YAML header, authored by any tool or human — junco is
harness-agnostic on the dispatch side.

```text
 🐦 junco  acme/reef-api   ●2 review · ⚑1 PR · ✓14 · daemon ● up 6h · ◐1 ⏳2
╭ 1 repos ─────────╮╭ 2 issues · 14 ─────────────────────╮╭ 3 PRs · reef-api ──────╮
│▌acme/reef-api 2● ││▌● #52 Fix reef color…   plan-ready ││▌✗ #52 fix-color-lut ✗2 │
│ acme/tide-cli    ││ ◐ #46 Bleaching alert      working ││ ◐ #48 tide-cache    ◍1 │
│──────────────────││ ○ #61 Add tide tables          3h  ││ ● #41 alert-copy    ✓4 │
│ queue            ││ ✓ #44 Coral survey       done  2d  ││                        │
│ ◐ #46 · turn 14  ││                                    ││                        │
│ 2 waiting        ││                             2/14   ││                        │
╰──────────────────╯╰────────────────────────────────────╯╰────────────────────────╯
 ↑/↓ move · ←/→ panes · enter preview · d dispatch · a approve · / filter · ? help
```

## The loop: label → plan → approve → PR

1. **Label an issue `junco`.** The daemon's next sweep verifies the labeler has
   write access, plans the work in a read-only session, and posts the plan as an
   issue comment — the issue flips to `junco:plan-ready`.
2. **Read the plan. Edit it if you like.** The comment is ordinary markdown, and
   whatever it says at approval time is what executes.
3. **Apply `junco:approved`.** Junco verifies who applied it (a write+
   collaborator) and that it postdates the plan comment, then queues an execution
   ticket — `junco:queued`, then `junco:working` while the agent runs in an
   isolated worktree with verification and a diff-vs-spec critic.
4. **The pull request arrives** as a draft carrying a deterministic
   `Closes owner/repo#N` line, and the issue flips to `junco:done` — or
   `junco:failed`, with the reason as a comment.

Three properties worth knowing:

- **Fails closed.** Ticket frontmatter is always built by the bridge — never from
  model output or issue text — and any verification error stops the dispatch.
- **Questions skip planning.** Add `junco:ask` alongside the trigger label for
  read-only Q&A, answered as a comment: no branch, no PR.
- **Offline-tolerant.** When GitHub is unreachable, labels, comments, and PR
  pushes queue in a durable outbox — FIFO replay, idempotent, dead-lettered after
  3 attempts. `junco outbox` inspects it; finished work is never lost to a dead
  network.

One issue, end to end:

```text
$ junco logs -f
09:14:07 INFO  github bridge: dispatched issue {"nwo":"acme/reef-api","issue":52,"id":"gh-acme-reef-api-52-plan","kind":"plan"}
09:14:52 INFO  [gh-acme-reef-api-52-plan] finalized {"dst":"done/gh-acme-reef-api-52-plan.md","status":"completed"}
── plan on #52 · junco:plan-ready · a human reads it, applies junco:approved ──
09:31:02 INFO  github bridge: approved plan dispatched for execution {"nwo":"acme/reef-api","issue":52,"id":"gh-acme-reef-api-52"}
09:31:05 INFO  claimed {"src":"inbox/gh-acme-reef-api-52.md","dst":"processing/gh-acme-reef-api-52.md"}
09:42:31 INFO  [gh-acme-reef-api-52] spec verification: 2/2 checks passed
09:42:58 INFO  [gh-acme-reef-api-52] critic: pass
09:43:41 INFO  [gh-acme-reef-api-52] pushed junco/gh-acme-reef-api-52 (3 new commits)
09:43:56 INFO  [gh-acme-reef-api-52] opened PR https://github.com/acme/reef-api/pull/57
09:43:57 INFO  [gh-acme-reef-api-52] finalized (pr-flow) {"dst":"done/gh-acme-reef-api-52.md","status":"completed"}
09:43:58 INFO  idle
```

→ [GitHub mode guide](docs/github-mode.md) — setup, lifecycle labels, trust model.

## Why junco

- **Plans before code** — the plan is an editable comment on the issue, and
  nothing executes until an approval that junco verifies (who applied it, and
  that it came _after_ the plan).
- **A dashboard worth living in** — a fullscreen terminal UI for the whole loop:
  watch repos, read plans, approve, track the queue, track your open PRs, and run
  any junco command from a palette without leaving it.
- **Tickets in, pull requests out** — a ticket is a Markdown file with a small
  YAML header. Junco claims it, works in an isolated git worktree, verifies the
  result, runs a diff-vs-spec critic, and opens a draft PR. Tickets without a
  `repo:` are Q&A: answered in place, read-only, no git involved.
- **Fork-PR mode** — `junco dispatch owner/repo#N` plans and PRs an issue on a
  repo you don't own: it forks, clones the fork into a managed directory, and
  opens the draft PR upstream — no labels or comments on their repo.
- **Supervised, not hopeful** — loop guards catch stuck agents, timeouts salvage
  the commits already made, transient failures retry with backoff, and every run
  leaves a full transcript.
- **Offline-tolerant** — when GitHub is unreachable, an outbox queues the
  comments, labels, and PR pushes durably and drains itself on reconnect.
- **Local-first by design** — your machine, your git, your `gh` auth, your choice
  of inference endpoint. There is no third service in the loop unless you choose
  one.
- **Its own GitHub identity, if you want one** — `junco auth login` (or the
  setup wizard's Account chapter) gives the daemon a dedicated bot account, so
  PRs, comments, and commits are attributed to the bot instead of you, and the
  account that approves work is not the one that dispatched it.

## It audits, you decide what to file

`junco assess <path|owner/repo|owner/repo#N>` audits a repo — `npm audit` for the
dependency tree plus a read-only agent pass over the code — and **parks** the findings for
review instead of filing them right away. `junco assess review` lists what's
pending; `junco assess review <id>` shows each finding's fingerprint, severity,
and title; `junco assess file <id> --all` (or `--only <fingerprint,…>`) files the
ones you confirm as GitHub issues titled `[<severity>] <title> (<ruleId>)`. Every
finding carries a fingerprint, and filing dedupes against your own most recent
500 issues on that repo — closed ones included — so nothing is filed twice.

It works on any watched repo, owned or not. On a repo you own, filed issues get
`junco:finding` + `severity/<level>` labels (best-effort), and `--auto-plan` adds
the trigger label so junco plans its own findings for you to approve. On a repo
you don't own, issues file label-free — junco never assumes triage rights it
doesn't have — and `--auto-plan` has no effect there.

Point it at one issue instead of the whole repo — `junco assess owner/repo#N`
— and the audit scopes to the code that issue implicates; filed findings carry
a `Context:` line GitHub cross-references onto the issue's timeline
automatically (no comment is posted; that's `junco analyze`, below). Unlike
the bare `owner/repo` form above, an issue reference auto-provisions an
unwatched repo the same way `junco dispatch`/`junco analyze` do.
→ [Vulnerability assessment guide](docs/assess.md)

## It investigates, you decide what to post

`junco analyze <owner/repo#N|issue-url>` reads a single issue and investigates
it against the repo, read-only — root cause, evidence, repro steps, a
suggested fix direction — then **parks** the result as a comment draft instead
of posting it. `junco analyze review` lists pending drafts; `junco analyze
review <id>` previews exactly what would post, footer included; `junco
analyze edit <id>` opens it in `$EDITOR` for a full rewrite; `junco analyze
post <id>` is the human confirm step that actually posts the comment. Every
posted comment carries a disclosure footer by default (`--no-footer` to omit
it). It works identically on owned and unowned repos — an unwatched repo is
auto-forked and provisioned the same way `junco dispatch` does.
→ [Analysis comments guide](docs/analyze.md)

## Sixty seconds to a running worker

Requires **Node ≥ 22.19**, plus `git` and an authenticated `gh` for PR flows. The execution sandbox is on by default: macOS uses the built-in Seatbelt (nothing to install); **Linux needs `bubblewrap`** (`apt install bubblewrap` / `dnf install bubblewrap`) — or set `sandbox.backend: "none"` / `sandbox.enabled: false`.

```bash
npx @ironforgesoftware/junco   # first run → setup wizard; afterwards → starts the daemon
```

`junco dashboard` (or bare `junco` on a first run) opens a full-screen guided
walkthrough — workspace, model setup (an inference endpoint with live
discovery, or a hosted provider from the built-in catalog), repo containment,
the GitHub bridge, and the recommended extras — then creates the queue,
verifies the result with a flight check, and lands you in the dashboard.
Re-run it anytime from the command palette ("setup") to tune an existing
config (it only writes what you change). `junco config init` scaffolds
defaults non-interactively — the headless equivalent for scripted setups.
(Prefer a global install: `npm install -g @ironforgesoftware/junco`, then the
command is just `junco`.)

```bash
junco dashboard                # the cockpit: watch repos, dispatch, approve, monitor PRs
junco start                    # or run the daemon in the foreground; Ctrl-C to stop
junco submit my-task.md        # feed it a Markdown ticket directly
```

## Or drop a ticket in a folder

The inbox is the second door: drop a Markdown ticket (`junco submit`, or any tool
writing files) and it runs the same 14-phase pipeline — claimed by atomic rename,
executed in a worktree, verified, reviewed by the critic, opened as a draft PR —
with requeue-and-backoff on transient failures. `junco schema` prints the
frontmatter contract, `examples/` has templates, and the bundled
**junco-dispatch** skill teaches coding agents to write well-formed tickets.
→ [Tickets guide](docs/tickets.md)

## Documentation

| Guide                                      | What's inside                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [Tickets](docs/tickets.md)                 | Ticket flavors, frontmatter reference, examples, submission, the PR-flow lifecycle                      |
| [Configuration](docs/configuration.md)     | The `config.json` skeleton, key knobs, hot-reload, and the `junco config` CLI                           |
| [GitHub mode](docs/github-mode.md)         | Setup, the plan → approve → PR loop, lifecycle labels, offline behavior, trust model                    |
| [Vulnerability assessment](docs/assess.md) | `junco assess` — audit any watched repo, review parked findings, file the ones you confirm              |
| [Analysis comments](docs/analyze.md)       | `junco analyze` — investigate an issue read-only, review the drafted comment, post the ones you confirm |
| [Dashboard](docs/dashboard.md)             | Every pane, key, and the command palette                                                                |
| [Bot account](docs/bot-account.md)         | Give the daemon its own GitHub identity — setup, how it works, doctor checks, migration notes           |
| [Operations](docs/operations.md)           | Health endpoint, running as a service, security model, troubleshooting                                  |
| [ARCHITECTURE.md](ARCHITECTURE.md)         | The runtime, module by module — accurate and maintained                                                 |

## CLI at a glance

|                                                               |                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `junco start` / `junco restart`                               | run the daemon / restart the installed service                                                                    |
| `junco submit <file>`                                         | queue a ticket (also reads stdin)                                                                                 |
| `junco dashboard`                                             | the fullscreen TUI                                                                                                |
| `junco dispatch <owner/repo#N \| url>`                        | plan and PR any repo's issue — direct branches when the bot can push, fork-PR mode otherwise                      |
| `junco status` / `junco list` / `junco logs -f`               | daemon, queue, and log visibility                                                                                 |
| `junco prs`                                                   | list junco-authored pull requests across watched repos                                                            |
| `junco assess <path\|owner/repo\|owner/repo#N> [--auto-plan]` | audit a repo, or scope to one issue (owned or external); findings await review (`assess review`, `assess file`)   |
| `junco analyze <owner/repo#N\|url>`                           | investigate an issue (owned or external); draft awaits review (`analyze review`, `analyze post`)                  |
| `junco retry <name…\|--all>`                                  | move failed tickets back to the inbox                                                                             |
| `junco outbox [flush]`                                        | inspect or push the offline GitHub backlog                                                                        |
| `junco doctor`                                                | preflight config, git/gh auth, endpoint, model                                                                    |
| `junco auth login`                                            | log the bot account in ([bot account guide](docs/bot-account.md))                                                 |
| `junco auth grant <owner/repo>`                               | grant the bot push access to a repo — invite as you, accept as the bot ([bot account guide](docs/bot-account.md)) |
| `junco config` / `junco schema` / `junco service`             | config get/set/init, ticket schema, service install                                                               |

## Contributing

Contributions are welcome — junco is young, and the codebase is still small
enough to hold in your head.

```bash
git clone https://github.com/ironforgesoftware/junco && cd junco
npm install
npm test          # vitest, ~1,915 tests, a few seconds
```

- Run the full gate before a PR:
  `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`
- Development is test-first with a commit per unit of work; the suite is green at
  every commit. Conventional commit messages (`feat:`, `fix:`, …).
- [ARCHITECTURE.md](ARCHITECTURE.md) is accurate and maintained — read it before
  touching the runtime, and keep it true when you do.
- For features, open an issue first — plans are cheap, rework isn't.

The longer version — conventions, testing expectations, commit and PR policy —
lives in [CONTRIBUTING.md](CONTRIBUTING.md). And junco can submit tickets against
itself — drop a PR-flow ticket with `repo:` pointing at this repository.

## License

[MIT](LICENSE)

_Named after the dark-eyed junco — a small, unassuming snowbird that works
through winter._
