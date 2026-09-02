# Security policy

Junco runs a coding agent with shell and file tools against tickets, pushes branches, and opens
pull requests on your behalf. That makes a private disclosure channel table stakes — this file
is it.

## Supported versions

Security fixes land on the **latest minor release line** of `@ironforgesoftware/junco` only
(`npm view @ironforgesoftware/junco version` shows the current one). Earlier minors are not
patched; upgrade to receive fixes.

| Version        | Supported |
| -------------- | --------- |
| latest minor   | yes       |
| earlier minors | no        |

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Report it privately through GitHub's
private vulnerability reporting for this repository:

https://github.com/ironforgesoftware/junco/security/advisories/new

If that form is unavailable to you, email the maintainer at the address in `package.json`
(`author`) with `[junco security]` in the subject.

Include what you can of: the affected version, the configuration that matters (sandbox backend
and `sandbox.enabled`, whether the GitHub bridge and the bot account are on,
`observability.healthHost`), reproduction steps, and the impact as you understand it.

You will get an acknowledgement within **72 hours**. From there the maintainer will confirm or
dispute the finding, agree a disclosure timeline with you, and credit you in the release notes
unless you prefer otherwise. Fixes ship as a patch release on the latest minor and are announced
in `CHANGELOG.md` and the GitHub advisory.

## Scope

These are the boundaries junco promises. A way to cross any of them is a vulnerability:

- **The execution sandbox boundary** (`src/agent/sandbox/`) — Seatbelt on macOS, bubblewrap on
  Linux, plus the in-process fs path-jail. A sandboxed agent writing outside its worktree grant,
  reaching the network without the per-ticket `network: true` opt-in, reading a scrubbed
  credential, or planting a git hook or `core.*` config that junco's own unsandboxed git calls
  later execute.
- **The GitHub bridge approval chain** (`src/githubInbox.ts`) — the label → plan → approve →
  execute loop. Executing without a verified write+ collaborator approval, an approval that
  predates the plan comment being honored, issue text or model output steering the
  `repo:`/`workdir:`/`tools:` frontmatter the bridge is supposed to build itself, or a forged
  plan comment passing as the bridge's own.
- **Bot-account authentication** (`src/ghAuth.ts`, `src/botIdentity.ts`, `src/scrubEnv.ts`) —
  the daemon's dedicated GitHub identity. The bot token reaching the agent plane, a push or `gh`
  call silently falling back to the operator's personal identity while a bot is configured, or
  the bot acting on a repo it was never granted.
- **The health endpoint** (`src/healthServer.ts`) — unauthenticated by design and bound to
  loopback (`127.0.0.1`) by default. Listening on a non-loopback address without an explicit
  `observability.healthHost`, or a response that leaks tokens, ticket bodies, or other secrets.

**Out of scope** — closed without a fix, though some make fine ordinary issues:

- Anything reachable only by someone who can already write to the inbox or edit `config.json`.
  The inbox is a code-execution boundary by design — see
  [Operations § Security model](docs/operations.md#security-model).
- Running with the sandbox off (`sandbox.enabled: false` / `sandbox.backend: "none"`), the
  approval gate off (`github.requireApproval: false`), or the health server deliberately exposed
  on a network interface.
- The residual sandbox gaps already documented in that Security model section and tracked as
  issues.
- Bugs in the inference endpoint, the model, `git`, `gh`, or the OS sandbox primitives
  themselves — report those upstream.
- Prompt injection that yields a bad plan or diff which a human then approves or merges — the
  plan review and the draft-PR gate are the intended control.
