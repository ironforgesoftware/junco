# Bot account

Give the daemon its own GitHub identity instead of running under yours.

[← back to the README](../README.md)

By default every `gh` and `git` call Junco makes runs under your ambient `gh auth` login and
host git identity — PRs, comments, labels, pushes, and commits all show up as you. Junco can
instead authenticate its daemon traffic as a **dedicated machine account** — a second, regular
GitHub account (e.g. `junco-agent`) that you create and invite onto your repos. Nothing about
this is required: with `botAccount.enabled` left at its default (`false`), behavior is unchanged.

## Why

- **Attribution.** PRs, issue comments, label edits, and commits the daemon makes are clearly
  the bot's, not yours — you can tell at a glance which activity on a repo came from Junco.
- **Approval separation.** With a bot account, the identity that dispatches work (the bot) and
  the identity that approves it (you, applying `junco:approved`) are distinct. Junco's approval
  check (`verifyLabelApplier`) still only looks at the human applier's permission — in normal
  operation the bot isn't approving its own work, so the approval gate keeps meaning something.
- **Non-owned-repo forks.** Fork-PR mode has never needed any cooperation from a repo's
  maintainers; what's new is the fork's _ownership_ — it's provisioned on the bot's account
  instead of yours, so the fork clutter (and the pushes to it) land on the bot, not your
  personal GitHub account.

## Setup

1. **Create the machine account** on github.com first — a normal account, not a GitHub App (e.g.
   `junco-agent`).
2. **Log it in**, either way:
   - **CLI:** `junco auth login`. It runs `gh auth login`'s own device-flow login into an
     isolated `GH_CONFIG_DIR`, verifies the resulting identity, and flips `botAccount.enabled`
     to `true` in `config.json` on success. It prints who Junco now acts as and reminds you to
     restart the daemon (`junco restart`) to apply it.
   - **Wizard:** the dashboard's setup walkthrough has an **Account** chapter (between GitHub and
     Extras) — choose "A dedicated bot account", and if no login exists yet under the config dir
     it offers to open the device-flow login for you (or you can skip it and run
     `junco auth login` later).
3. **Invite the bot onto your watched repos.** The bot needs a one-time collaborator invite:
   **write** (or higher) on any repo where Junco pushes branches directly, or **triage** at
   minimum if you only need the GitHub bridge's label edits (planning/approval/lifecycle labels)
   to work — triage can't push branches, so direct-branch tickets on that repo will still fail
   until you upgrade it to write. Repos you don't own need **no invite at all**: those go through
   fork-PR mode, and the fork now lands on the bot's own account.

## How it works

The config surface is additive and off by default:

```jsonc
"botAccount": {
  "enabled": false,                   // absent/false = today's ambient behavior
  "configDir": "~/.config/junco/gh"   // isolated gh config dir; overridable
}
```

- **Isolated credential storage.** The bot's login lives in its own `GH_CONFIG_DIR` (default
  `~/.config/junco/gh`), completely separate from your own `gh` config. `gh` itself owns token
  refresh — nothing secret ever lands in `config.json` or the daemon's own `process.env`; child
  processes only ever receive the config-dir _path_. When the execution sandbox is on, the
  bot's config dir joins the agent's read-deny list (alongside `~/.config/gh` and the other
  built-in secret paths), so sandboxed agent tools can't read the bot's token either.
- **Daemon-only boundary.** The bot identity is attached to `Config` (as `ghAuth`) only at the
  entrypoints that run unattended: `junco start`/`junco run-once`, and everything downstream of
  them — the PR flow, worktree operations, and the GitHub inbox/outbox/reporter. Interactive
  commands stay on your personal login: dashboard GitHub actions (except add-repo provisioning —
  see the next bullet), `junco assess`/`junco analyze` posting, `junco submit`, and
  `junco doctor`'s ambient probes.
- **Fork provisioning exception.** One deliberate carve-out: provisioning a fork or managed
  clone for a repo you don't own always runs as the bot, even though it's human-triggered —
  the fork it creates is the daemon's future push target, so it has to live on the bot's
  account from the start. This covers every call site that shares the provisioning path:
  `junco dispatch`, `junco analyze`, `junco assess` pointed at an unowned repo's issue (clone
  only — it deliberately skips the fork), and the dashboard's add-repo flow. The issue read
  that precedes it (`gh issue view`) stays on your ambient login.
- **Per-worktree commit identity.** Every PR-flow worktree gets `extensions.worktreeConfig`
  enabled (one inert flag written once into the parent clone's `.git/config` — invisible to you)
  and its own `user.name`/`user.email` set via `git config --worktree` to the bot's login and its
  noreply email (`<id>+<login>@users.noreply.github.com`). That means every process that commits
  inside the worktree — the agent's own commits and Junco's `commitLeftovers` sweep alike —
  authors as the bot, while your host git identity is never touched.
- **The `git.ts` auth seam.** `runCmd` accepts an `env` option merged over `process.env`; `gh()`
  injects `GH_CONFIG_DIR` whenever the resolved config carries a bot identity (and clears
  `GH_TOKEN`/`GITHUB_TOKEN`, which gh would otherwise prefer over the `GH_CONFIG_DIR`-stored
  login), and `git()` does the same plus pins a credential helper for remote operations
  (`-c credential.helper=` to clear any inherited helper, then
  `-c credential.helper=!<gh> auth git-credential`) so pushes and fetches authenticate as the bot
  regardless of your own global gitconfig. This is applied uniformly and is harmless on local-only
  git operations.
- **Refuse-to-start posture.** If `botAccount.enabled` is `true` but the bot's login is missing
  or expired, `junco start` and `junco run-once` refuse to run at all — they resolve the auth
  context _before_ taking the daemon lock or touching the log file, and exit with a message
  pointing at `junco auth login`. There is no silent fallback to your personal identity: that
  would quietly undo both the attribution and the approval-separation properties above.

## Working in an organization

Org repos are usually private, and fork-PR mode either doesn't apply (org policy commonly
forbids private forks) or isn't what you want for repos you already control. For those, the
bot needs its own collaborator grant — either one repo at a time or once via a team.

### `junco auth grant <owner/repo>`

One command drives both identities junco holds:

1. **Invite as you.** Junco calls GitHub as your own ambient login —
   `PUT repos/<owner>/<repo>/collaborators/<bot-login>` with `permission=push`. You need
   **admin** on the repo (or an org admin willing to run the command for you); anything less
   fails with a message pointing that out.
2. **Accept as the bot.** Junco switches to the bot's isolated `GH_CONFIG_DIR`, lists its
   pending invitations, and accepts the one matching this repo (bounded retry — invitation
   propagation can lag a moment).
3. **Verify.** A final check under the bot's identity confirms it now has push before the
   command reports success (`✓ <bot-login> has write on <owner/repo>`).

Idempotent: if the bot is already a collaborator, step 1's invite call comes back empty
(GitHub's "already a collaborator" response) and the command skips straight to verifying —
re-running `junco auth grant` on an already-granted repo is a safe no-op.

The dashboard does this for you automatically: after you add a repo to the watchlist with
`botAccount.enabled` on, junco checks whether the bot already has push and, if not, runs the
same grant in the background. A grant failure shows a toast naming the `junco auth grant
<owner/repo>` fix — it never un-adds the repo you just watched.

### SSO / SAML-enforced orgs

If the org enforces SAML SSO, the grant's API calls fail with a **SAML enforcement** error
from `gh`, regardless of which identity performed them. That isn't a permission problem —
it's a one-time **authorization** step, and it has to happen in the bot's own browser
session: sign in as the bot on github.com and authorize its `gh` OAuth token for the org
(GitHub prompts for this the first time a SAML org is touched). Nothing junco does can
automate that click-through. `junco auth grant` and `junco doctor` both recognize the SAML
error and print this guidance instead of a generic access-denied message; the setup wizard's
read-only flight check does not distinguish the cause — a SAML-blocked bot shows the same
generic "no push — run: junco auth grant" hint there as any other access gap.

### Seats

Outside collaborators added to **private** repos count toward the per-seat billing on
GitHub plans that meter seats (Team/Enterprise). Granting the bot access to many private
repos one at a time can add up in seats — check your plan before granting broadly, or use
the team route below, which is one membership instead of N collaborator grants.

### Alternative: add the bot to a team

Instead of granting repo by repo, add the bot account to a GitHub team that already has
write access to the repos it needs — a one-time step in GitHub's own UI (org → Teams →
members), not something junco automates or has a command for. Once the bot has push via
team membership, `classifyRepoAccess` sees it exactly like a direct collaborator grant, so
those repos already read as `direct` and `junco auth grant` has nothing to do on them.

### Unwatched-repo dispatch: what happens without a grant

`junco dispatch`, `junco analyze`, and `junco assess <owner/repo#N>` all resolve an
unwatched repo the same way, classifying the bot's access before touching anything:

| Repo state (bot's access)                                         | Mode        | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push access (granted, team membership, or already a collaborator) | **direct**  | Fork-less clone; branches push straight to the repo. **The repo is auto-onboarded**: added to the watchlist as a first-class entry (`external: false`) — from then on the bridge sweeps it for trigger labels exactly like a repo you configured yourself, permanently, with **no confirmation step**. This includes `junco assess` scoped to one issue: even that nominally read-only audit leaves a push-accessible unwatched repo watched afterward. |
| Public, no push access                                            | **fork**    | Unchanged fork-PR mode: the bot forks the repo to its own account, clones the fork, and opens the PR upstream. Also recorded in the watchlist, but as `external: true` — that flag excludes it from the bridge's label sweep, so it's watched only for PR listing, not lifecycle automation.                                                                                                                                                            |
| Private, no push access                                           | **blocked** | Fails loud before cloning anything. With the bot account enabled, the error names the fix — `junco auth grant <owner/repo>` (or the SSO guidance above, if that's the cause); with it disabled, you get a plain access-denied message, since there's no bot to grant. Nothing is added to the watchlist.                                                                                                                                                |

If an auto-onboarded repo isn't one you meant junco to watch permanently, unwatch it from
the dashboard (`x` on the repo) or remove its entry from `<stateDir>/github-watchlist.json`
by hand.

## Doctor

`junco doctor` checks the bot identity whenever `botAccount.enabled` is `true`:

- Resolves the bot's identity under its config dir (`gh api user` with `GH_CONFIG_DIR` set).
  Not logged in → a hard failure pointing at `junco auth login`.
- Warns if the bot's login is the same as your own ambient `gh` login — a same-login setup
  defeats the point (no attribution or approval-separation benefit).
- For each watched repo, checks the bot's permission level (`gh repo view --json
viewerPermission`, run as the bot): `write`/`maintain`/`admin` is fine; `triage` gets a warning
  that label edits will work but branch pushes will fail; anything less warns you to invite the
  bot as a collaborator.

## Migration notes

- **Historical dedup mismatch.** GitHub-side dedup for `junco assess` findings and outbox replay
  keys off `gh api user`/`--author @me`, which now resolves to the bot instead of you. Comments
  and issues you posted by hand under your own login won't match anymore, so you may see **one
  one-time duplicate** plan-comment or finding on a pre-existing thread the first time it's
  touched after enabling the bot. This is documented behavior, not a bug, and it self-resolves —
  every subsequent dedup check runs consistently as the bot.
- **Stale personal-fork remotes.** If you already have external clones from before the bot was
  enabled, their `fork` remote points at _your_ fork — the bot can't push there, and the push
  will fail loud. Fix: remove the stale `fork` remote from the managed clone and let Junco
  re-provision it; the new fork it creates lands on the bot's account.
- **Same-login warning.** If you log the bot in under your own account (rather than a separate
  machine account), doctor warns you — see above. It still works, but you lose the attribution
  and approval-separation properties that are the whole point of this feature.
- **Approval security improvement.** Nothing about approval checking changed:
  `verifyLabelApplier` still verifies the _human_ applier's write-plus permission, and approval
  labels still only ever come from a human. What's different is that, in normal operation, the
  identity opening PRs and posting plan comments is distinct from the identity approving them —
  dispatcher and approver are no longer the same account, which is a real security improvement
  over the ambient-auth default.
- **Repo access model, summarized.** Watched repos (the ones in `config` or the dynamic
  watchlist) need a one-time write invite for the bot to push branches directly — triage is the
  floor for the GitHub bridge's own label edits to keep working, but not enough for direct
  branch pushes. Repos you don't own need no cooperation from their owners at all: they go
  through fork-PR mode, and the fork is provisioned on the bot's account.
