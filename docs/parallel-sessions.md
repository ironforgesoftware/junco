# Parallel development sessions

Running several Claude Code (or other agent) sessions against this repo at once, one git worktree
per feature — without disturbing the live junco daemon that runs from this checkout.

[← back to the README](../README.md)

## Why worktrees

The main checkout doubles as the maintainer's live runtime (see CLAUDE.md): the launchd daemon
executes `dist/` from here, and `config.toml`, `tickets/`, `worktrees/` are live state. A worktree
gives each parallel session its own working tree, branch, `node_modules/`, and `dist/` — builds and
test runs in one session can't touch the daemon's build or another session's files.

## Pattern A (preferred): native worktree sessions

From the main checkout, let the harness manage the worktree:

```bash
cd ~/junco && claude -w <topic>        # add --tmux for an iTerm2 tmux session
```

Launching from `~/junco` keeps the session's project identity (auto-memory, project settings) on
the junco project while the working tree is isolated. Inside a session, the `EnterWorktree` tool
does the same thing.

## Pattern B (manual): `worktrees-manual/`

`worktrees-manual/` is gitignored for exactly this purpose:

```bash
cd ~/junco
git worktree add worktrees-manual/<topic> -b feat/<topic>
cd worktrees-manual/<topic> && npm ci
claude
```

Caveat: a session launched from inside the worktree path gets a separate Claude Code project
identity — junco project auto-memory won't load. Prefer Pattern A when that matters.

## Rules

- **Never place dev worktrees under `worktrees/`.** That directory is the daemon's
  `worktree_root`; junco creates and force-removes per-ticket worktrees there
  (`src/worktree.ts`). Anywhere else is safe — junco's cleanup is strictly path-scoped to
  `<worktree_root>/<ticket-slug>`.
- **One branch per worktree**, `feat/<topic>` off `main` (git refuses to check out the same
  branch twice anyway).
- **`npm ci` per worktree.** Dependencies are exact-pinned; `node_modules/` and `dist/` are
  per-worktree, so a worktree build never touches the daemon's live `dist/`.
- **The main checkout is the daemon's build home.** Park it on `main` once the current branch
  merges; rebuild there only to promote a release into the running daemon
  (`npm run build` → `junco restart`). Feature work happens in worktrees.
- **Sandbox smoke tests exactly as CLAUDE.md prescribes.** A worktree has no `./config.toml`, so
  config resolution falls back to the user-level default — which is the maintainer's *live*
  config. Never run `junco start` or submit test tickets from a worktree either.
- **Full gate per branch** before PR: `npm run lint && npm run format:check && npm run typecheck
  && npm run build && npm test`.
- **Keep sessions off each other's subsystems.** Two sessions editing the same module trade the
  serialization you removed for rebase conflicts. Split work by module boundaries
  (see ARCHITECTURE.md's module map).
- **Survey what's in flight before designing, not just before merging.** At session start — and
  again before writing a spec or plan — check open PRs and unmerged branches
  (`gh pr list`, `git fetch && git branch -r`). Branch names double as the claims board: if
  another `feat/*` or `fix/*` branch names your subsystem, design against what it's about to
  land, or sequence behind it. A collision spotted at design time costs a paragraph; the same
  collision at merge time costs a semantic conflict resolution.
- **Merge `origin/main` into long-running branches between tasks, not at the end.** When main
  moves under a multi-task branch, fetch and merge at the next task boundary and re-run the
  gate. Conflicts then arrive one commit at a time, while both sides are fresh — and a design
  collision surfaces while the design is still cheap to adapt. A branch that runs many tasks
  without syncing discovers every conflict at once, at PR time, in its most expensive form.
- **Land small; don't let branches age.** Conflict exposure is roughly surface area × hours
  unmerged. Independent tickets ship as independent PRs even when one session produced them;
  bundling is only worth it when the pieces genuinely share plumbing.
- **Clean up:** `git worktree remove <path>` after the branch merges; `git worktree prune`
  occasionally. Pattern-A worktrees are cleaned up by the harness.

## Why not parallelize through junco itself?

Junco's scheduler (`runScheduler` in `src/daemon.ts`) supports `max_concurrent > 1`, but tickets
targeting the same repo always serialize by design — so dispatching several junco-dev tickets at
this repo still runs them one at a time. Lifting that constraint would be a junco feature in its
own right, not a workflow change.
