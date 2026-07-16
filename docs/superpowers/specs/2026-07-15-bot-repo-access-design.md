# Bot repo access — classification, grants, auto-onboard (design)

**Date:** 2026-07-15
**Status:** approved
**Branch:** `feat/bot-repo-access` (stacked on `feat/gh-bot-account`, PR #186)

## Problem

With the bot account shipped (PR #186), repo access has two flows whose selection is
manual and whose failure mode is wrong for organizations: unwatched repos always take the
fork path (correct for open-source contribution, impossible or wrong for private org
repos — org policy typically blocks private forks), and getting the bot write access to a
repo is a two-terminal ceremony (invite as the human, accept as the bot). The operator
has to know which flow a repo will take and pre-arrange access by hand.

## Requirements (settled in brainstorming)

1. **Fork flow stays** for contributing to unowned public repos — untouched.
2. **Private org repos work**: the bot CAN be granted access (operator has admin or a
   cooperating org admin), so the design is grant automation, not identity overrides.
3. **Grant trigger:** automatic at repo-add time (dashboard) + doctor fix hint + explicit
   `junco auth grant` escape hatch. Never at dispatch time; never daemon-initiated.
4. **Unwatched repo dispatch is permission-aware with auto-onboard**: bot has push →
   fork-less managed clone, watchlist entry `external: false`, first-class from then on;
   public without push → fork path as today; private without push → fail loud naming the
   grant command.

## Architecture

### `src/botAccess.ts` (new)

- `classifyRepoAccess(cfg, nwo, deps): Promise<RepoAccess>` where
  `RepoAccess = { mode: "direct" } | { mode: "fork" } | { mode: "blocked"; reason: "no-access" | "sso" }`.
  One `gh repo view <nwo> --json viewerPermission,isPrivate` call **under whatever
  identity `cfg` carries** (bot when `ghAuth` attached, ambient otherwise — ambient-only
  users get the private-repo dispatch fix for free):
  - viewerPermission ADMIN/MAINTAIN/WRITE → `direct`
  - otherwise `isPrivate: false` → `fork`
  - otherwise → `blocked`/`no-access`
  - call fails 404 → `blocked`/`no-access` (callers reach classification only after an
    ambient read of the repo succeeded, so 404-under-bot means private-and-invisible —
    GitHub deliberately hides private repos from non-members)
  - call fails 403 with the SAML-enforcement marker in stderr → `blocked`/`sso`
- `grantBotAccess(cfg, nwo, deps): Promise<{ login: string }>`:
  1. Resolve the bot login from `botAccount.configDir` (error if bot mode disabled).
  2. **As the human (ambient cfg):** `gh api repos/<nwo>/collaborators/<bot> -X PUT -f permission=push`.
     HTTP 201 → invitation created; 204 → already a collaborator (idempotent success,
     skip to verification).
  3. **As the bot (`GH_CONFIG_DIR` env):** list `/user/repository_invitations`
     (`--paginate`), accept the entry whose `repository.full_name` matches (PATCH), with
     a short bounded retry for propagation.
  4. Verify: `viewerPermission` as the bot must be push+; return the login.
  - Failure mapping: 403 without admin → "you need admin on <nwo> (or ask an org
    admin)"; SAML 403 → SSO authorization guidance (one-time browser step in the BOT's
    session: authorize the gh OAuth token for the org — not automatable); org policy
    forbidding outside collaborators → surface the API's own message.
- All gh calls via the `gh()` wrapper (bot identity by attaching `ghAuth` to the cfg
  passed in; ambient by not attaching); exec/probe seams injectable per house style.

### Permission-aware dispatch — `resolveIssueTarget` (src/externalDispatch.ts)

Watched repos (config ∪ non-external watchlist): unchanged. Unwatched:

```
botCfg = withBotAuthFn(cfg)                       // existing
access = classifyFn(botCfg, nwo)                  // new
blocked → throw: "bot has no access to <nwo> (private) — run: junco auth grant <nwo>"
          (sso reason → the SSO guidance instead)
direct  → ensureCloneFn(botCfg, nwo, deps, { fork: false })
          watchlist entry { nwo, path, external: false }   // AUTO-ONBOARD
fork    → ensureCloneFn(botCfg, nwo, deps, { fork: true }) // byte-for-byte today's path
          watchlist entry { external: true }
```

- `IssueTarget.external` becomes `access.mode === "fork"` for the unwatched branch
  (direct auto-onboard → `external: false`, `forkNwo: null`) — so direct-mode tickets
  carry no `push_remote`, the reporter works, and PRs get labels. **No ticket-schema
  changes.**
- Explicit consequence of auto-onboard: the repo is first-class immediately — the bridge
  sweeps it for trigger labels (when `github.enabled`), it appears in the dashboard, and
  future dispatches take the watched path.
- Caller override preserved: `opts.fork === false` (assess's read-only path) always
  clones fork-less regardless of mode; `external` recorded per classification; `blocked`
  still throws (a clone of an invisible private repo cannot succeed anyway).

### CLI — `junco auth grant <owner/repo>`

Second verb on the existing `authCmd` (`login` | `grant`); USAGE updated. Validates the
nwo shape, loads config (must exist; `botAccount.enabled` must be true), runs
`grantBotAccess`, prints `✓ bot has write on <nwo>` or the mapped failure. Idempotent.

### Wiring

- **Dashboard add-repo:** after a successful add, when `botAccount.enabled` and the bot
  lacks push, run the grant automatically (new `GhClient` method wrapped in the existing
  `attempt()` Result pattern) and toast the outcome. A grant failure warns with the CLI
  command and never un-adds the repo.
- **Doctor:** the per-repo bot-access warnings gain the suffix
  `fix: junco auth grant <nwo>`; the bot probes learn the SAML-403 → SSO-guidance
  mapping.
- **Wizard:** read-only — the Finale flight check gains a per-repo bot-access receipt
  with the grant hint. No GitHub mutations mid-wizard.

### Docs

`docs/bot-account.md` gains a "Working in an organization" section: the grant command
and its two-identity mechanics; the one-time SSO token authorization for SAML orgs; the
seat note (outside collaborators on private repos consume a license seat on paid plans);
the org-team alternative (add the bot to a team once instead of per-repo grants —
documented, not automated); and the dispatch classification table (direct / fork /
blocked).

## Boundary & security

Granting mutates repo collaborators, so it fires only from human-triggered surfaces
(CLI, dashboard add-repo, doctor's printed command) using the operator's ambient admin
credential; the accept step is the bot exercising its own account. The daemon never
grants. No changes to the daemon auth seam, sandbox policy, or scrubEnv.

## Testing

- `botAccess` classification: exec-fake matrix — WRITE/MAINTAIN/ADMIN → direct;
  public-no-push → fork; private-no-push → blocked/no-access; 404 → blocked/no-access;
  SAML 403 stderr → blocked/sso. Fakes discriminate on the presence of `GH_CONFIG_DIR`
  in the child env (the T8 verdict-flipping pattern) so identity selection is pinned.
- `grantBotAccess`: scripted fakes — 201 → invitation accepted as bot (env-pinned) →
  verified; 204 → idempotent success without the accept step; 403-no-admin and SSO
  mapped messages; propagation retry bounded.
- `resolveIssueTarget`: direct → `fork: false` reaches the clone fn AND the watchlist
  entry is `external: false`; blocked → throw contains `junco auth grant <nwo>`; public
  fork path pinned unchanged; assess `{fork:false}` override pinned.
- authCmd verb routing (grant happy/failure paths, config-gating), doctor hint lines,
  ghClient add-repo grant call + failure-warns-but-keeps-repo — all via the existing
  fake-gh / exec-fake / Result patterns.

## Out of scope

Dispatch-time auto-granting (rejected in brainstorming), org-team automation, GitHub
App, any change to fork PR mechanics, per-repo identity overrides.
