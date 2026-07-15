# Junco's own GitHub account (bot identity) — design

**Date:** 2026-07-15
**Status:** approved
**Branch:** `feat/gh-bot-account`

## Problem

Every gh and git call junco makes runs under the maintainer's ambient `gh auth` and host
git identity. PRs, comments, labels, pushes, and commits are all attributed to the human,
which muddles provenance (which PRs did the agent open?), weakens approval semantics (the
same identity dispatches and approves), and blocks working on repos where the maintainer's
identity shouldn't be the actor. There is no auth seam: `runCmd` in `src/git.ts` spawns
children with inherited `process.env` and no `env` option; no git author/committer identity
is set anywhere.

## Decisions (settled in brainstorming)

1. **Identity mechanism: machine account** (a second regular GitHub account, e.g.
   `junco-agent`), authenticated via gh's own device-flow login. GitHub App rejected — see
   Rejected alternatives.
2. **Scope boundary: daemon = bot, human = you.** All daemon traffic (worker PR flow,
   bridge polling and label edits, outbox replay) runs as the bot. Interactive commands
   (dashboard gh actions, assess/analyze posting, doctor's ambient probes) stay under the
   personal login. One deliberate exception: fork provisioning at dispatch time always uses
   the bot context, because the fork it creates is the daemon's future push target.
3. **Credential storage: isolated gh config dir.** One-time `gh auth login` into a
   junco-owned `GH_CONFIG_DIR` (default `~/.config/junco/gh`). gh owns token refresh;
   nothing secret lands in `config.json` or the daemon's `process.env` (children get a dir
   path, not a token).
4. **Commit authorship: the bot authors all worktree commits** (agent-made and junco's
   `commitLeftovers`), via per-worktree git config — the host identity is untouched.
5. **Repo access: permission-adaptive, as today.** Repos in the watched set (config ∪
   watchlist) push direct branches — the bot needs a one-time write invite there (the
   bridge's label edits need ≥ triage anyway). Everything else goes through the existing
   fork mode (`src/externalRepo.ts`), with forks now provisioned on the bot's account — so
   non-owned repos need no cooperation from their owners.

## Architecture

### `src/ghAuth.ts` (new)

- `GhAuthContext = { configDir: string; login: string; email: string }`.
- `resolveBotAuth(cfg, deps): Promise<GhAuthContext | null>` — `null` when
  `botAccount.enabled` is false. Otherwise runs `gh api user` with
  `GH_CONFIG_DIR=<configDir>` and builds the noreply email
  `<id>+<login>@users.noreply.github.com`. Resolved once at startup, cached on the config
  object.
- One shared login routine (spawn `gh auth login` with `GH_CONFIG_DIR` set and inherited
  stdio) consumed by both the `junco auth login` CLI and the wizard chapter.
- Exec calls go through an injectable deps seam per house style.

### Config surface (additive)

```jsonc
"botAccount": {
  "enabled": false,                   // absent/false = today's ambient behavior
  "configDir": "~/.config/junco/gh"   // defaulted, overridable
}
```

`Config` also carries an optional runtime-resolved `ghAuth?: GhAuthContext` — not part of
the schema or `config.json`; entrypoints attach it (see Boundary).

### The auth seam (`src/git.ts`)

- `runCmd` learns an `env` option (merged over `process.env` for the child).
- `gh()` injects `GH_CONFIG_DIR` when the cfg carries `ghAuth`.
- `git()` injects the same env **plus a pinned credential helper** for remote operations:
  `-c credential.helper=` (clears inherited helpers) then
  `-c credential.helper=!<ghBin> auth git-credential`. The helper is spawned by git and
  inherits the child's `GH_CONFIG_DIR`, so pushes/fetches authenticate as the bot
  regardless of the user's global gitconfig. Applied uniformly (harmless on local-only
  ops).
- `planLint.ts` `_fetchRepoLabels` migrates from its private `execFileSync` onto the `gh()`
  wrapper — after this, `git.ts` covers 100% of runtime gh/git spawns (doctor/wizard's
  `execProbe` remains a separate, diagnostic-only seam and gains bot-aware probes).

### Boundary — who attaches `ghAuth`

- **Attach:** daemon (`start`/`service`), `run-once`, and everything downstream of them
  (prFlow, worktree ops, inbox/outbox/report, scheduler).
- **Don't attach:** interactive commands — dashboard gh actions (`tui/ghClient.ts`),
  assess/analyze posting, `submit`, doctor's ambient checks.
- **Exception:** `dispatchIssue`/`analyze`'s clone+fork provisioning
  (`ensureExternalClone`/`ensureFork`) runs with the bot context even though
  human-triggered — the fork must live on the bot's account. Dispatch-time reads
  (`gh issue view`) stay ambient.

### Commit identity

`prepareWorktree` enables `extensions.worktreeConfig` on the parent repo (one-time flag
write to its `.git/config`; inert for humans; git ≥ 2.20) and sets `user.name` /
`user.email` (bot login + noreply address) via `git config --worktree`. Per-worktree config
means any process committing in the worktree gets the bot identity — the agent's bash tool
(sandboxed or not) and `commitLeftovers` — chosen over env-var injection precisely because
env vars silently fall back to the host identity when the sandbox is off.

### Provisioning UX

- **`junco auth login` (new CLI subcommand):** interactive `gh auth login` with
  `GH_CONFIG_DIR` set (inherited stdio, gh's own device-flow UX), then verifies by
  resolving the identity, flips `botAccount.enabled` in config, and prints who junco now
  is. Headless/re-auth vehicle.
- **Wizard/FTUE — new "Account" chapter** between `Github` and `Extras` in the chapter
  rail (`src/tui/wizard/WizardApp.tsx`):
  1. Toggle — "Who should junco act as on GitHub?" → _Your gh login_ (default; chapter
     ends) / _A dedicated bot account_ (patches `answers.botAccount.enabled = true`).
  2. Detect — new probe in `src/wizard/detect.ts` (`gh auth status` + `gh api user` under
     the config dir). Already logged in → `✓ acting as <login>`, move on.
  3. Login — "Log in as the bot (opens your browser)" calls a new `io.runInteractive()`
     seam on `buildWizardIO`: the dashboard host suspends Ink (releases raw mode, clears),
     runs the shared login routine with inherited stdio, resumes, re-detects. A "skip —
     I'll run `junco auth login` later" option covers the cautious path.
- `buildConfigObject` / `answersFromConfig` / `diffAnswers` in `src/wizard/flow.ts` learn
  the `botAccount` block so the in-palette setup re-run round-trips it.

### Doctor & failure posture

- Bot mode enabled + login missing/expired → **daemon refuses to start** with a clear
  message (silent fallback to the personal identity is an attribution and self-approval
  hazard).
- Doctor gains: bot identity resolution under the config dir; a warning when bot login ==
  ambient login (defeats the purpose); per-watched-repo `gh repo view --json
viewerPermission` **as the bot** — write+ for direct branches, triage+ for bridge label
  edits, else "invite the bot or expect fork mode".

### Sandbox & containment

- `botAccount.configDir` joins the sandbox deny list next to `~/.config/gh`
  (`src/agent/sandbox/policy.ts`).
- `scrubEnv`'s allowlist already drops `GH_CONFIG_DIR` by construction — a test pins it.
- The daemon's own `process.env` never contains the pointer (child-env only), so the
  sandbox-off default-SDK-bash path exposes nothing beyond what `~/.config/gh` already
  risks today.

### Migration & identity-sensitive logic

- Outbox dedup (`gh api user`, `--author @me`) resolves to the bot going forward;
  historical comments/issues posted by the human stop matching — at most a one-time
  duplicate plan-comment/finding per pre-existing thread. Documented, not mitigated.
- Existing external clones whose `fork` remote points at the _personal_ fork fail loud on
  push (bot can't push there). Migration: remove the stale `fork` remote and let
  re-provisioning create the bot's fork.
- `verifyLabelApplier` (approval security) unchanged — it checks the _human_ applier's
  permission; approval labels keep coming from the human, so the bot never approves its
  own work. Net improvement: dispatcher and approver are now distinct identities.
- `githubPrs` filters by branch prefix, not author — unaffected.

### Testing

- Fake-gh shell scripts (existing pattern, e.g. `tests/repo.test.ts`) echo
  `$GH_CONFIG_DIR` so tests assert env injection through the real spawn path.
- `ghAuth` resolution/login tests use injected exec fakes.
- Worktree tests (real git harness) assert bot authorship on commits inside the worktree
  **and** that the parent repo's `user.*` config is untouched.
- Doctor/wizard tests via `execFn` fakes; the wizard chapter's `io.runInteractive()` is a
  fake per the existing wizard-test pattern (no Ink suspension in tests).

## Out of scope (file as follow-up issues)

- `junco auth status` / `junco auth logout` subcommands (doctor covers status; logout is a
  documented manual `gh auth logout` with the env var set).
- Fork-PR CI caveats doc (fork PRs run upstream CI without secrets).
- GitHub App backend (revisit if junco becomes hosted/multi-user).

## Rejected alternatives

- **Daemon-process-wide `GH_CONFIG_DIR`:** near-zero seam code, but dispatch runs in the
  CLI process (forks would land on the personal account), git push still needs the
  credential-helper injection, and the pointer leaks into every child including the
  sandbox-off SDK bash — ends up needing the seam anyway, plus global mutable env.
- **PAT in config (`$ENV_VAR`, mirroring `model.apiKey`):** works headless but the human
  owns PAT creation/expiry/rotation and the token transits the daemon process.
- **GitHub App:** better token hygiene (≤1h installation tokens, least privilege, `[bot]`
  badge, no seat) but disqualified on capability, not just complexity: an App acts only on
  repos where it's _installed_, and installation requires the repo owner. The fork path
  doesn't rescue it — an installation token scoped to the bot's fork cannot open the PR on
  _upstream_ (needs `pull_requests: write` there), whereas a machine account's user token
  opens PRs on any public repo like a human contributor. Also: gh has no native App auth
  (junco would own JWT signing + hourly token refresh), and the app's private key is a
  worse secret to contain than the gh token it replaces.
