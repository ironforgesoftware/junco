# GitHub-first README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `README.md` GitHub-first per the approved spec at `docs/superpowers/specs/2026-07-09-readme-github-first-design.md`, gate it, and open a PR for the maintainer's merge.

**Architecture:** Single-file content change in the junco repo, executed in the worktree `/Users/alxedelweiss/junco/worktrees-manual/readme-github-first` on branch `docs/readme-github-first` (off origin/main at d7ce62a). The dashboard mock and log transcript are extracted from the junco-site checkout (`/Users/alxedelweiss/junco-site/site/index.html`) — the code-verified source of truth — with specified glyph restorations. npm deps are already installed in this worktree; the suite measures 1,654 tests.

**Tech Stack:** Markdown, python3 one-liners for extraction/verification, the repo's own quality gate (`npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`), `gh` for the PR.

## Global Constraints

- **No AI attribution in any commit or PR body** — no `Co-Authored-By: Claude` trailer, no "Generated with Claude Code" line; amend away if auto-appended.
- **Stack-agnostic** (README ships in the npm tarball): no AI vendor/model/inference-server names; only "inference endpoint" / "any **OpenAI-compatible inference endpoint**". No personal-setup strings.
- No hype words: blazing, seamless, revolutionary, supercharge, magical, easy, simply, powerful.
- Only `README.md` changes in the content commit (the spec + this plan are already committed on the branch).
- All work in `/Users/alxedelweiss/junco/worktrees-manual/readme-github-first`. NEVER touch the main checkout at `/Users/alxedelweiss/junco` (live daemon home), `config.toml`, `tickets/`, or `worktrees/`.
- Conventional commits. The PR is opened, never merged — merging is the maintainer's.
- Exact strings (labels, log lines, ids) come from the extraction sources and the literals in this plan — verified against src/ this session; do not paraphrase them.

---

### Task 1: Rewrite README.md

**Files:**
- Modify: `README.md` (full rewrite; final content assembled below)

**Interfaces:**
- Consumes: `/Users/alxedelweiss/junco-site/site/index.html` (read-only) for the mock + transcript extraction.
- Produces: the README Task 2 gates and ships.

- [ ] **Step 1: Extract the dashboard mock from the site and restore the real TUI glyphs**

```bash
cd /Users/alxedelweiss/junco/worktrees-manual/readme-github-first
python3 - <<'EOF'
import re, html
doc = open('/Users/alxedelweiss/junco-site/site/index.html').read()
m = re.search(r'<pre class="diagram" aria-hidden="true">\n?( junco[\s\S]*?)</pre>', doc)
text = html.unescape(re.sub(r'<[^>]+>', '', m.group(1)))
# Restorations: the site substituted these for font-subset reasons that don't apply on GitHub/npm.
text = text.replace(' junco  acme/reef-api', ' 🐦 junco  acme/reef-api', 1)
text = text.replace('✗1 PR', '⚑1 PR')
text = text.replace('◐1 · 2 waiting', '◐1 ⏳2')
text = re.sub(r'(tide-cache\s+)◐1', r'\g<1>◍1', text)
open('/tmp/readme-mock.txt', 'w').write(text)
lines = [l for l in text.split('\n') if l.strip()]
boxed = {len(l) for l in lines if l[0] in '│╭╰'}
assert len(boxed) == 1, boxed          # all boxed lines equal width
assert '🐦' in lines[0] and '⚑' in lines[0] and '⏳' in lines[0]
assert any('◍1' in l for l in lines)
print('mock OK,', len(lines), 'lines, boxed width', boxed.pop())
EOF
```
Expected: `mock OK, 10 lines, boxed width 84`.

- [ ] **Step 2: Extract the log transcript from the site**

```bash
python3 - <<'EOF'
import re, html
doc = open('/Users/alxedelweiss/junco-site/site/index.html').read()
demo = re.search(r'<pre class="demo" id="demo">([\s\S]*?)</pre>', doc).group(1)
spans = re.findall(r'<span\s+class="l[^"]*"[^>]*>([\s\S]*?)</span>(?=<span|\s*$)', demo)
lines = [html.unescape(re.sub(r'<[^>]+>', '', s)) for s in spans]
lines = [l.rstrip('▌') for l in lines]           # drop the animated caret
text = '\n'.join(lines)
open('/tmp/readme-transcript.txt', 'w').write(text)
assert lines[0] == '$ junco logs -f' and lines[-1].endswith('idle') and len(lines) == 12, (len(lines), lines[:2], lines[-1])
assert 'gh-acme-reef-api-52-plan' in text and 'critic: pass' in text
print('transcript OK, 12 lines')
EOF
```
Expected: `transcript OK, 12 lines`. If the span regex fights the HTML, fall back to: extract the whole `<pre ... id="demo">…</pre>` block, replace `</span>` with `\n`, strip remaining tags, unescape, drop empty lines and the `▌` — then re-run the assertions.

- [ ] **Step 3: Write the new README.md**

Replace the entire file with the content below. `[MOCK]` = the verified `/tmp/readme-mock.txt` content; `[TRANSCRIPT]` = the verified `/tmp/readme-transcript.txt` content — paste them in verbatim (they are the ONLY two splices; everything else is literal).

````markdown
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
**OpenAI-compatible inference endpoint** you point it at: your code, your git, and
your credentials stay in a loop you control. The other door is a folder: Markdown
tickets with a small YAML header, authored by any tool or human — junco is
harness-agnostic on the dispatch side.

```text
[MOCK]
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
[TRANSCRIPT]
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
  of inference endpoint. There is no third service in the loop.

## It files its own issues

`junco assess <path|owner/repo>` audits a repo — `npm audit` for the dependency
tree plus a read-only agent pass over the code — and files the findings as GitHub
issues titled `[<severity>] <title> (<ruleId>)`, labeled `junco:finding` and
`severity/<level>`. Every finding carries a fingerprint, and new runs dedupe
against the most recent 500 finding issues — closed ones included — so nothing is
filed twice. With `--auto-plan`, each new issue also carries the trigger label:
junco plans its own findings, and you approve the ones worth doing.
→ [Vulnerability assessment guide](docs/assess.md)

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
| `junco dispatch <owner/repo#N \| url>`          | fork-PR mode: plan and PR an external repo's issue      |
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
npm test          # vitest, ~1,650 tests, a few seconds
```

- Run the full gate before a PR:
  `npm run lint && npm run format:check && npm run build && npm test`
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
````

- [ ] **Step 4: Verify**

```bash
cd /Users/alxedelweiss/junco/worktrees-manual/readme-github-first
# every relative link target exists
python3 - <<'EOF'
import re, os
s = open('README.md').read()
links = re.findall(r'\]\((?!http)([^)#]+)\)', s)
missing = [l for l in links if not os.path.exists(l)]
assert not missing, missing
print('links OK:', sorted(set(links)))
EOF
# stack-agnostic + hype-word sweep (expect exit 1 = no matches)
grep -inE 'anthropic|claude|gpt|gemini|llama|mistral|deepseek|qwen|ollama|vllm|lm.?studio|mlx' README.md; echo "vendor exit: $?"
grep -in 'openai' README.md | grep -vi 'openai-compatible'; echo "openai exit: $?"
grep -inE 'blazing|seamless|revolutionary|supercharge|magical|\beasy\b|\bsimply\b|powerful' README.md; echo "hype exit: $?"
# the two splices really are the verified extractions
python3 -c "
readme = open('README.md').read()
assert open('/tmp/readme-mock.txt').read().strip() in readme, 'mock splice drifted'
assert open('/tmp/readme-transcript.txt').read().strip() in readme, 'transcript splice drifted'
print('splices OK')
"
```
Expected: `links OK`, three `exit: 1`, `splices OK`.

- [ ] **Step 5: Commit**

```bash
git add README.md && git commit -m "docs: restructure README GitHub-first — the loop, assess, dashboard-forward"
```

---

### Task 2: Quality gate + PR

**Files:** none modified (gate + push only).

**Interfaces:**
- Consumes: Task 1's commit on `docs/readme-github-first`.

- [ ] **Step 1: Full gate in the worktree** (deps already installed)

```bash
cd /Users/alxedelweiss/junco/worktrees-manual/readme-github-first
npm run lint && npm run format:check && npm run typecheck && npm run build && npm test > /tmp/readme-gate-test.log 2>&1; echo "exit: $?"; grep -E 'Tests|Test Files' /tmp/readme-gate-test.log
```
Expected: `exit: 0`, `Tests  1654 passed` (or higher if main moved). If the count no longer rounds to ~1,650 (i.e. it is < 1,600 or ≥ 1,700), update the README's two `~1,650` mentions to the new round number, re-run Task 1 Step 4's greps, and amend the commit.

- [ ] **Step 2: Push and open the PR (do NOT merge)**

```bash
git push -u origin docs/readme-github-first
gh pr create --title "docs: restructure README GitHub-first" --body "Restructures README.md to match the positioning of junco.ironforgesoftware.com — GitHub-first, TUI-forward — while staying a reference document.

- Tagline: _Issues in. Pull requests out._
- New **The loop** section: label → plan → approve → PR walkthrough with the exact lifecycle labels, trust-model notes, and the \`junco logs -f\` transcript from the site (all strings code-verified).
- New **It files its own issues** section (\`junco assess\`, fingerprint dedup incl. closed issues, \`--auto-plan\`).
- Dashboard mock synced to the site's aligned 84-ch layout with the real TUI glyphs restored (🐦 ⚑ ⏳ ◍).
- \`junco dispatch\` added to the CLI table; Why-junco bullets reordered GitHub/TUI-first; \"Two ways to feed it\" folded into The loop + \"Or drop a ticket in a folder\".
- Test count refreshed: ~1,100 → ~1,650 (suite measures 1,654).

npm's package page picks this up with the next release.

Spec: docs/superpowers/specs/2026-07-09-readme-github-first-design.md"
```
Verify the PR body rendered without any AI-attribution line; the plan + spec commits ride along on the branch by design.

- [ ] **Step 3: Report the PR URL**

Paste the PR URL in your report. Merging is the maintainer's call — stop here.

---

## Self-review notes

- Spec coverage: tagline/positioning (T1 S3), mock glyph restorations (T1 S1), loop + labels + transcript (T1 S3 + S2), Why-junco reorder with the GitHub-native bullet replaced by Fork-PR mode (the loop section now covers dispatch-by-label; fork-PR facts verified against docs/github-mode.md:59-72), assess with the closed-issues dedup fact (T1 S3), sixty-seconds reorder, folder section, tables (+ `junco dispatch` row), test count 1,654 → "~1,650" (T2 S1 re-verifies), bird line, gate + PR (T2). "Draft" in loop step 4 is verified: `draft_by_default: true` (src/config.ts:174) and the bridge does not override it.
- No placeholders: `[MOCK]`/`[TRANSCRIPT]` are named splices of verified extraction outputs with assertion gates and a drift check in T1 S4.
- The spec's "verify table rows at impl" is satisfied in-plan: CLI table checked against src/cli.ts's command set this session (all rows present; `dispatch` was the one missing) and docs table paths are covered by the link-existence check in T1 S4.
