# Agent Execution Sandbox — Design

**Status:** approved (brainstorm 2026-07-10)
**Author:** maintainer + Claude
**Related:** `docs/operations.md` § Security model; issues #103 (structural no-post), #105 (fork-less clone), #106 (branch-isolation tests)

## 1. Problem

Junco drives the Pi coding agent **in-process**. Once a session includes the `bash`
tool (the PR-flow default), the model can run arbitrary shell as the daemon user with:

- **the daemon's full `process.env`** — including `GH_TOKEN` / inference API keys
  (`getShellEnv()` returns `{...process.env}` to every shell child);
- **no filesystem confinement** — `cwd` is only a starting directory; `cd /`, absolute
  paths, and `~` expansion all work. Even a "read-only" Q&A session (tool-list-limited to
  `read/grep/find/ls`) can read `~/.ssh`, `~/.config/gh`, and `config.toml`;
- **unrestricted network egress** — `curl`, `git push`, `gh api` to anywhere.

Containment today is entirely **policy-in-process**: tool-name allowlists, `allowed_repo_roots`,
machine-owned frontmatter, and env-scrubbed + time-boxed _verification_ blocks. There is no
OS-level isolation anywhere. The asymmetry is stark: ticket-authored verification bash gets a
scrubbed env (issue #35), but model-authored bash — a far larger surface — gets everything.

The documented stance is "the inbox is a code-execution boundary — control who writes to it."
That is correct but insufficient as junco moves toward external/untrusted repos and an
unattended, always-on daemon.

## 2. Goals / Non-goals

**Goals**

1. **Host-damage containment** — a buggy/runaway agent (or a repo's own test/build commands)
   cannot write outside its worktree + a scratch dir.
2. **Credential/secret containment** — the agent plane never holds GitHub or inference
   credentials, and cannot read the operator's secrets (`~/.ssh`, `gh` config, keychain,
   junco's own config/state).
3. **Egress containment** — agent tool subprocesses have **no network by default**;
   exfiltration and unsolicited pushes are structurally blocked.
4. **Offline-first** — the sandbox must not depend on any network service or heavyweight
   runtime. Junco must keep working with no internet and no Docker.
5. **Dedicated GitHub identity** — junco authenticates to GitHub as a scoped machine account,
   separate from the operator's personal credentials.

**Non-goals (this spec)**

- Kernel-exploit resistance / defense against a determined attacker who already has code
  execution and a kernel 0-day. Native OS sandboxes share the host kernel; this is the
  documented, accepted limit of the whole native-sandbox category (Claude Code, Codex, Cursor
  all share it).
- Running genuinely untrusted third-party repos safely. That needs a VM/container boundary and
  is **Phase 2**, explicitly deferred behind a backend seam.
- Resource quotas (CPU/mem/pids) as a hard wall. Best-effort `ulimit`s are in scope; cgroup/VM
  enforcement is Phase 2.

## 3. Threat model

The operator dispatches tickets (trusted authorship) that may pull in **untrusted content**
(repo files, issue bodies, dependency code) which can steer the model via prompt injection.
The lethal trifecta is tool access + untrusted content + an exfil path. This design removes the
exfil path (egress deny) and the credentials (env scrub + dedicated identity), and caps the
blast radius (filesystem confinement), for the _trusted-author_ case. The _untrusted-author_
case (external dispatchers writing to the inbox / untrusted repos) is bounded but not solved
until Phase 2.

## 4. Architecture

### 4.1 Two planes

```
┌─ DAEMON PLANE (privileged, host) ─────────────────────────┐
│  junco daemon, prFlow orchestration                        │
│  git / gh subprocesses  ← hold the dedicated-identity PAT  │
│  talks to the inference endpoint (model traffic)           │
└────────────────────────────────────────────────────────────┘
                    │ constructs tools for ↓
┌─ AGENT PLANE (unprivileged, sandboxed) ───────────────────┐
│  Pi agent tool execution:                                  │
│    bash   → spawned through OS sandbox, scrubbed env,      │
│             no network, writes confined to worktree+scratch│
│    read/write/edit/grep/find/ls → JS path-jail to          │
│             worktree+scratch (+ read allowlist)            │
│  NO GitHub credential. NO inference key. NO operator secrets.│
└────────────────────────────────────────────────────────────┘
```

The key structural fact that makes offline deny-all egress free: **model traffic does not pass
through the sandbox.** Pi runs in-process; the daemon (not a sandboxed child) talks to the
inference endpoint. So the agent's tool subprocesses can be denied _all_ egress — even
loopback — while inference, PR creation, and the whole flow keep working with no internet.
This is the inverse of Claude Code, whose entire process sits inside the sandbox and therefore
needs an allowlist proxy just to reach its own model.

### 4.2 Where junco intervenes — the Pi SDK tool seam

Because Pi executes tools in-process, there is **no junco-side spawn to wrap** for the agent's
bash. Junco intervenes at tool _construction_ time via SDK seams (all verified present in
`@earendil-works/pi-coding-agent` 0.80.3):

- **`customTools: ToolDefinition[]`** on `createAgentSession(...)` — a custom tool named `bash`
  fully shadows the built-in. Junco builds each enabled tool via the SDK's own
  `createBashTool(cwd, {operations, spawnHook, commandPrefix, shellPath})` etc., wrapping it
  with sandbox policy. This is a pure `createAgentSession` option — no extension system needed.
- **`BashSpawnHook`** / custom **`BashOperations`** — rewrite `command`/`cwd`/`env` immediately
  before spawn. This is where the env scrub and the sandbox-exec/bwrap command prefix are
  applied.
- **In-process `read`/`write`/`edit`/`ls`/`find`/`grep`** are plain fs calls (no subprocess),
  so an OS sandbox cannot see them. They get a **JS path-jail** via each tool's `Operations`
  seam (resolve → assert under an allowed root / read-allowlist → else throw).
- **`resourceLoader` with `noExtensions: true`** — pass an explicit `DefaultResourceLoader` so
  the daemon session cannot auto-load ambient `~/.pi` or repo-local `.pi` extensions. Closes a
  code-injection side door that exists today regardless of sandboxing.

### 4.3 The OS sandbox backend

A `SandboxBackend` interface with `auto | seatbelt | bwrap | none` implementations:

- **macOS → Seatbelt** via `sandbox-exec -p <SBPL profile>`. Profile: write allowed only under
  the worktree + a per-ticket scratch dir + `/dev/null`; read broad minus a deny-list; network
  denied.
- **Linux → bubblewrap** (`bwrap`) with bind mounts: worktree + scratch read-write, system
  paths read-only, `--unshare-net` for no egress.
- **`none`** — explicit opt-out (returns the command unwrapped). Used on unsupported platforms
  only when the operator sets it.
- The bash policy is applied as a **command prefix** (the SDK's `commandPrefix` /
  `BashSpawnHook` supports exactly this): the model's command runs as
  `sandbox-exec -p <profile> bash -c <cmd>` (macOS) / `bwrap <args> bash -c <cmd>` (Linux).

We **do not** take a dependency on `@anthropic-ai/sandbox-runtime` (srt) initially: it is a
0.0.x beta releasing 1–3×/week (clashes with junco's exact-pin discipline), and most of its
machinery (domain-allowlist proxies, interactive prompting) solves problems junco does not have
under deny-all egress. Junco's policy is small enough for templated SBPL/bwrap profiles with
strong prior art (Bazel, Codex, Claude Code). The `SandboxBackend` seam keeps srt — or a
Phase-2 container — swappable later.

### 4.4 Fail-closed

If the sandbox backend cannot initialize (binary missing, profile rejected, unsupported
platform with `backend != none`), the **ticket fails** with a clear error. It does **not**
silently run unsandboxed. There is **no per-command escape hatch** analogous to Claude Code's
`dangerouslyDisableSandbox` — junco is unattended, so there is no human to approve an escape.
Isolation replaces supervision (the design lesson from unattended agents like Jules/Copilot,
and from Hermes' "containers substitute for approval prompts").

Rationale for asymmetry with Claude Code (which fails _open_ by default): Claude Code has a
human in the loop who sees "sandbox unavailable, running unsandboxed" and can react. Junco does
not. A failed ticket is recoverable (fix config, requeue); a silent unsandboxed run on an
unattended box is not.

## 5. Network default: deny, with per-ticket opt-in

Default `network = "deny"` for **all** agent sessions (PR, Q&A, assess). This works offline by
construction. The occasional ticket that must reach the network (e.g. `npm install` a new
dependency from the registry) opts in with per-ticket frontmatter:

```yaml
network: true # additive to ticketSchema; default false; only widens this one ticket
```

mirroring the existing `tools:` opt-in pattern and the CLAUDE.md hard rule ("Q&A defaults are
read-only; per-ticket frontmatter is the explicit opt-in; never widen the default"). Day-to-day
tickets are unaffected: junco already symlinks the host repo's `node_modules` into the worktree,
so tests run offline.

`network: true` still runs inside the filesystem sandbox — it relaxes only egress. (Phase 1
egress opt-in is all-or-nothing per ticket; per-domain allowlisting is a possible future
refinement via srt's proxy, out of scope here.)

## 6. Configuration

New `[sandbox]` TOML section (additive; every field optional with a default, per junco's
schema discipline):

```toml
[sandbox]
enabled = true            # master switch; false = current behavior (back-compat default TBD §9)
backend = "auto"          # auto | seatbelt | bwrap | none
network = "deny"          # deny | allow  (per-ticket `network: true` overrides to allow)
extra_deny_read = []      # additional absolute paths/globs to deny reads (adds to built-ins)
extra_allow_write = []    # additional absolute paths to permit writes (adds to worktree+scratch)
```

Built-in read deny-list (always applied, not operator-removable): `~/.ssh`, `~/.aws`,
`~/.config/gh`, `~/.gnupg`, the resolved `config.toml` path, the state dir, `~/.pi`. Built-in
write allow-list: the session worktree + the per-ticket scratch dir + `/dev/null` (+ `$TMPDIR`
redirected into scratch).

Wiring, per CLAUDE.md's "adding a Config field" checklist:

1. zod object with `.default({})` in `TomlSchema` (`src/config.ts`).
2. camelCase fields on `Config` (`src/types.ts`), mapped in `loadConfig`, `expandHome()` applied
   to path fields.
3. Update every full-`Config` test fixture (`makeConfig`/`cfg()` in
   `tests/{runOnce,prFlow,orphans,repo,worktree,daemon}.test.ts`).
4. Optionally surface in the wizard's `renderConfigToml`.

## 7. Dedicated GitHub identity

Operational, not code (junco already performs all `git push` / `gh pr create` itself, so the
agent plane never needs a token once §4 lands):

1. Create a machine GitHub account (or a fine-grained PAT under one) scoped to **only** the
   repos junco may touch, with only the permissions the PR flow needs (contents:write,
   pull_requests:write).
2. Authenticate the **daemon** with it (its own `gh`/`GH_TOKEN`, on the daemon plane only).
3. The env scrub (§4.2) guarantees the token never reaches agent bash.
4. Document in `docs/operations.md` § Security model as the recommended deployment.

## 8. Testing strategy

- **Unit (platform-agnostic, the bulk):** the policy layer — profile/argv generation for each
  backend, the env-scrub allowlist, the JS path-jail (`isUnderRoot`, read-deny matching),
  config parsing/defaults, per-ticket `network` opt-in threading. These are pure functions
  tested with string/param assertions, no OS calls — mirroring how `verify.ts` env-scrub is
  tested today.
- **Backend seam:** `SandboxBackend` injected via a `*Deps` seam so flows can be tested with a
  fake backend that records the wrapped command without executing it.
- **Integration (gated by platform):** a small suite that actually runs a wrapped `bash -c`
  under Seatbelt on macOS runners / bwrap on Linux runners and asserts (a) a write outside the
  worktree fails, (b) reading `~/.ssh/...`-shaped path fails, (c) a network call fails, (d) a
  write inside the worktree succeeds. Skipped when the backend binary is absent so unit CI stays
  green everywhere.
- **Fail-closed:** assert that an unavailable backend surfaces a ticket failure, never an
  unsandboxed run.
- Existing suite (~1,500 tests) must stay green; the `npm run typecheck` gate catches missed
  `Config` fixtures.

## 9. Rollout & the back-compat default (open decision)

The one genuinely reversible-but-visible choice: does `[sandbox].enabled` default to `true` or
`false` on upgrade?

- **Default `true`** — secure by default; but a repo whose tests need network or write outside
  the worktree could start failing on upgrade for existing users. Mitigated by fail-closed
  clarity + `network:true` / `extra_allow_write` escape valves + CHANGELOG guidance.
- **Default `false`, wizard sets `true` for new installs** — zero upgrade surprise; existing
  behavior preserved; new users get the safe default. Requires operators to opt in.

**Recommendation:** ship `enabled` defaulting to **true** with a loud CHANGELOG note and a
one-line opt-out, _because_ junco is an unattended daemon holding credentials — the failure mode
of an insecure default (silent exfil) is worse than the failure mode of a secure default (a
ticket fails with an actionable message). Confirm at plan-review time; it is a one-line change
either way.

## 10. Phasing

- **Phase 0 — credential separation** (no OS sandbox): env scrub for agent bash (extract the
  `verify.ts` allowlist), `resourceLoader` `noExtensions`, dedicated-identity docs. Biggest
  risk reduction per line; mechanism-independent.
- **Phase 1 — native sandbox:** `SandboxBackend` (seatbelt/bwrap/none), filesystem confinement,
  deny-all egress, JS path-jail, `[sandbox]` config, per-ticket `network` opt-in, fail-closed,
  doctor preflight, integration tests.
- **Phase 2 — deferred:** container/VM backend for untrusted repos; per-domain egress; hard
  resource quotas. Behind the same seam; build only when the untrusted-work scenario is concrete.

This spec covers Phase 0 + Phase 1.
