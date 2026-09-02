# End-to-end testing — design

Date: 2026-09-01
Status: approved (brainstormed in-session; implementation plan follows)

## 1. Goal

Add an end-to-end layer above the unit/flow suite that exercises what the unit
suite structurally cannot:

1. **The real process boundary.** The built `dist/cli.js` runs as a child
   process in a sandboxed `HOME`: real config resolution, real queue-directory
   atomics, real log sinks, real exit codes.
2. **The real Pi SDK wiring.** `src/agent/session.ts`'s runtime
   `await import("@earendil-works/pi-coding-agent")` — today touched only in
   production — runs against a local scripted model server, so an SDK upgrade
   that changes event shapes, tool schemas, or the provider protocol fails a
   test instead of a live ticket.
3. **The packaging surface.** The tarball-installed CLI processes a full
   ticket, not just `--help` (extends `scripts/package-smoke.sh`).
4. **Real model runs.** The same harness, pointed at a live inference endpoint
   by explicit env vars, run manually. Never a merge gate.

The unit suite (4,191 tests at time of writing) already covers the
orchestration logic in-process against fakes (`AgentSessionLike`, inline
`gh` shell scripts, a real git harness). This layer does not duplicate that;
it proves the wiring between the pieces the fakes replace.

## 2. Non-goals

- Replacing or thinning the unit suite. Coverage thresholds in
  `vitest.config.ts` remain the coverage authority; the e2e layer collects no
  coverage (the code under test runs in a child process).
- Testing model quality. The live layer asserts outcomes (ticket in `done/`,
  branch exists, file content), never transcript shape or turn counts.
- CI wiring for the live layer. The maintainer's endpoint is local; there are
  no secrets to hand a runner. `workflow_dispatch` can be added later.
- Faking auth, thinking blocks, or token accounting in the stub. Added only
  when a scenario needs them.

## 3. Layout and runner wiring

```
tests/e2e/
  harness.ts          sandbox + git remote + fake gh + ticket writer + CLI runner + readers
  stubModel.ts        scripted OpenAI-compatible model server
  prFlow.e2e.ts       pr-happy-path
  qa.e2e.ts           qa-read-only
  requeue.e2e.ts      transient-requeue
  daemon.e2e.ts       daemon-lifecycle (last task of the plan)
  live.e2e.ts         real-model layer, env-gated
vitest.e2e.config.ts  include tests/e2e/**/*.e2e.ts; fileParallelism false; testTimeout 120 s
```

- `npm run test:e2e` → `vitest run -c vitest.e2e.config.ts`.
- `npm run test:e2e:live` →
  `JUNCO_E2E_LIVE=1 vitest run -c vitest.e2e.config.ts tests/e2e/live.e2e.ts`.
  The script sets the gate; the operator supplies the endpoint vars (§7.3).
  Scenario test names contain their §6 slug verbatim (`pr-happy-path`, …), but
  selection is by FILE with `-t <slug>` as a secondary filter, never `-t`
  alone: `vitest run -t <slug>` with zero matches exits 0, so `-t` by itself
  cannot guard against a renamed test (§7.2 relies on this).
- The `.e2e.ts` suffix never matches the unit glob (`tests/**/*.test.ts`).
  `vitest.config.ts` additionally gains `exclude: ["tests/e2e/**"]` so the
  intent is visible in the unit config, not just implied by naming.
- Lint (`eslint.config.js` files `tests/**/*.ts`), typecheck
  (`tsconfig.eslint.json` includes `tests`), and prettier (`tests/**/*.{ts,tsx}`)
  already cover the new folder. No config change there.
- Files run serially (`fileParallelism: false`): each scenario spawns a
  process and binds a port. Tests within a file also run serially (vitest
  default).
- **Precondition: `dist/cli.js` exists.** A `globalSetup` in
  `vitest.e2e.config.ts` fails with `run \`npm run build\` first` if it does
  not. The suite never builds on its own — the same honesty rule as
  `package-smoke.sh`: you test what is there, so a stale `dist/` is the
  operator's responsibility and never silently masked by an implicit rebuild.
- **`JUNCO_E2E_BIN`** overrides the binary under test (default:
  `node <repo>/dist/cli.js`). This is how the packaging layer reuses the
  entire suite (§7).

## 4. The harness (`tests/e2e/harness.ts`)

`createSandbox(opts)` builds the four ingredients every scenario needs and
returns handles for assertions.

### 4.1 Sandboxed HOME

- `mkdtemp` under `os.tmpdir()`; `HOME` and `XDG_CONFIG_HOME` both point inside
  it. Config resolution is HOME-anchored (`src/config.ts` — `env.HOME` wins
  over `os.homedir()`), so nothing the child does can reach the maintainer's
  live `~/.junco`.
- The harness writes `<sandbox>/.junco/config.json` **directly** as a minimal
  literal, not via `config init`. An explicit literal is easier to read in a
  failing test and exercises loading a user-authored file. Baseline literal:

  ```jsonc
  {
    "model": {
      "id": "e2e/stub",                 // provider prefix "e2e" → inline resolution path
      "api": "openai-completions",      // the schema default, stated explicitly
      "baseUrl": "http://127.0.0.1:<port>/v1",
      "apiKey": "e2e"                   // inline path requires one; the stub ignores it
    },
    "git": { "ghBin": "<sandbox>/bin/gh" },
    "observability": { "healthPort": <free port> }   // daemon-lifecycle only
    // dataDir omitted → defaults under $HOME/.junco → queue, worktrees,
    // transcripts, metrics, logs all land inside the sandbox.
  }
  ```

  `opts.config` deep-merges over this literal so a scenario can state exactly
  the one thing it changes.
- **Sandbox enforcement stays at the production default (on).** CI installs
  bubblewrap on Linux and macOS ships seatbelt, so the e2e run exercises real
  confinement inside the real process — coverage the unit suite's synthetic
  `/sbxroot` paths cannot give. A scenario may pass
  `config: { sandbox: { enabled: false } }` explicitly; the harness never
  disables it silently. On a Linux dev box without bwrap the run fails closed
  with junco's own doctor-style message — that is the intended behavior, not a
  skip.

### 4.2 Real git remote

Reuses `tests/helpers/gitHarness.ts` (`cloneHarness(dest)` → `{ remote, work }`:
a bare `remote.git` on `main` plus a `work` clone whose `origin` is the bare
repo). `work` is the ticket's `repo:` (the public schema's "absolute path to
the target git repo"). The PR flow's worktree branches from `origin/main` and
pushes to `origin`, so assertions read the bare remote directly:
`remote.branches()` (`git for-each-ref refs/heads`), `remote.log(branch)`,
`remote.fileAt(branch, path)` (`git show <branch>:<path>`).

`allowedRepoRoots` defaults to `[]`, which junco treats as "anywhere"
(`src/assessFlow.ts:189`, `src/analyzeFlow.ts:135`), so the sandbox clone
needs no allow-listing.

### 4.3 Fake `gh`

Reuses `ghCases()` from `tests/helpers/ghScript.ts` — same
no-permissive-default philosophy: a case table per scenario, and anything
unmatched fails with `fake-gh: unhandled: <args>` on stderr and exit 1. The
harness wraps each case body so it first appends its full argv to
`<sandbox>/gh.log`; the log is the assertion surface ("one `pr create` with
`--base main --head junco/<id>`").

The happy path needs at minimum `repo view --json nameWithOwner` (answered by
`ghCases` itself), `pr list` (existing-PR check), and `pr create` (must print a
URL — `src/pr.ts:213` throws otherwise). The exact table is discovered by
running: the unhandled-call failure names the missing case. That discovery is
the first task's TDD red.

### 4.4 Ticket writer

`writeTicket(sb, { id, frontmatter, body })` writes
`<queueRoot>/inbox/<id>.md`. `frontmatter` keys are checked at write time
against the public `ticketSchema` field names (the schema is a runtime object
typed `Record<string, unknown>`, so there is no static key type to compile
against); a harness that used a non-public key throws before the CLI runs.
The queue root is derived the same way junco derives it
(`<dataDir>/queue`) — the harness asks `junco inbox-path` once rather than
hard-coding the layout.

### 4.5 Process runner

`runOnce(sb, { timeoutMs = 90_000 })` spawns the binary under test with
`run-once` and a **scrubbed environment**: only `HOME`, `XDG_CONFIG_HOME`,
`PATH`, `TMPDIR`, and (on macOS) the locale vars the toolchain needs. Nothing
else is inherited — no `JUNCO_*`, no real `HOME`, no shell customizations —
so the maintainer's live runtime and launchd state cannot be reached even by
a bug in the harness. Captures stdout/stderr; on timeout sends `SIGTERM`, then
`SIGKILL` after 5 s, and rejects — a hang fails the test instead of wedging
CI. Returns `{ code, stdout, stderr }`.

`runOnce` returns exit 0 after one `runOnce()` attempt whether or not a ticket
was handled (`src/cli.ts:824-826`); the queue state, not the exit code, is the
primary assertion.

`startDaemon(sb)` / `stopDaemon(handle)` (daemon-lifecycle only) spawn
`start`, poll `http://127.0.0.1:<healthPort>/health` with the existing
`until` helper, and stop it with `SIGTERM` — there is no `junco stop`
subcommand — asserting the pidfile is gone.

### 4.6 Readers and cleanup

- `queueState(sb, id)` → `{ dir: "inbox"|"processing"|"done"|"failed", frontmatter }`
  (parsed with the same `yaml` dependency the product uses).
- `transcript(sb, id)` → parsed `<dataDir>/data/transcripts/<id>.jsonl`.
- `ghLog(sb)` → argv lines from `gh.log`.
- `afterEach`: `rm -rf` the sandbox unless `JUNCO_E2E_KEEP=1`, in which case
  the path is printed for post-mortems.

## 5. The stub model server (`tests/e2e/stubModel.ts`)

`startStubModel(script: Turn[])` → `{ url, requests, exhausted, close() }`. A
plain `node:http` server bound to `127.0.0.1:0` (kernel-assigned port) running
inside the vitest process while the CLI runs as a child.

### 5.1 Protocol

Verified against `@earendil-works/pi-ai/dist/api/openai-completions.js`
(vendored under `pi-coding-agent/node_modules`, SDK 0.84.2): the adapter uses
the official `openai` client, `client.chat.completions.create(params)` with
streaming, and consumes standard chunk deltas (`choices[0].delta.content`,
`choices[0].delta.tool_calls[]` with `index`/`id`/`function.name`/
`function.arguments`, `finish_reason`, a trailing `usage`).

Routes:

- `POST /v1/chat/completions` — pops the next turn and streams it as SSE:
  a role delta; then content deltas **or** tool-call deltas; then a chunk with
  `finish_reason: "stop"` or `"tool_calls"`; a usage chunk with constant
  numbers; `data: [DONE]`. If the request carries `stream: false` the same
  turn is returned as one non-streamed body — cheap insurance against the
  adapter flipping modes on an SDK upgrade.
- `GET /v1/models` — `{ "data": [{ "id": "stub" }] }`, in case registry
  resolution probes it.
- Anything else — 404, recorded in `requests` with the path.

### 5.2 Turns

```ts
type Turn =
  | { kind: "text"; text: string }
  | { kind: "tool"; calls: Array<{ name: string; args: Record<string, unknown> }> }
  | { kind: "error"; status: number; body?: string };
```

Tool names and argument shapes are the SDK's real ones — e.g. `write` takes
`{ path, content }` (`pi-coding-agent/dist/core/tools/write.js:12-14`), `bash`
takes `{ command }`. The agent executes the call in-process and sends the
result back as the next request, exactly as in production.

### 5.3 Recording and fail-fast

- Every request body (`model`, `messages`, `tools`, `stream`) is pushed to
  `requests` in arrival order. Scenarios assert on what the real SDK sent:
  the ticket body reached the user message, the tool list for a Q&A ticket is
  exactly the read-only set, the tool result from turn N is present before
  turn N+1.
- When the script is exhausted the stub answers 500 `stub script exhausted`,
  sets `exhausted = true`, and keeps answering 500. Every scenario asserts
  `exhausted === false`. The loop guards and ticket timeout remain a backstop;
  they are never the mechanism that ends a test.

## 6. Scenarios

Each is the smallest ticket that proves one end-to-end property.

1. **`pr-happy-path`** (`prFlow.e2e.ts`). Ticket with `repo: <work clone>`.
   Script: `tool write hello.txt` → `tool bash "git add -A && git commit -m 'add hello'"`
   → `text "Done."`. Assert: exit 0; ticket in `done/`; bare remote has
   `junco/<id>` exactly one commit ahead of `main` and `hello.txt` at that
   branch has the scripted content; `gh.log` has exactly one `pr create` with
   `--base main` and `--head junco/<id>`; transcript contains both tool calls;
   `requests[0].messages` includes the ticket body; `exhausted` is false.
   This single test crosses every layer in §1.1–1.2.
2. **`qa-read-only`** (`qa.e2e.ts`). Ticket without `repo:`; one `text` turn.
   Assert: `done/`; the ticket file ends with a `## Result` section containing
   the scripted text (`src/finalize.ts:33`); `requests[0].tools` names are
   exactly `{read, grep, find, ls}` — the never-widen hard rule from
   `CLAUDE.md`, proven at the wire.
3. **`transient-requeue`** (`requeue.e2e.ts`). Script: `error 503` first.
   Assert: ticket back in `inbox/` with `retry_count: 1` and a `not_before`
   in the future; no `junco/*` branch on the remote; exit 0. The scenario sets
   `model.retry.maxRetries: 0`, so this exercises `src/providerFailure.ts`
   classification at the SDK's error boundary with the SDK's own retries
   disabled, not through its retry/backoff path — the sticky 503 (`times:
   Infinity`) already makes the stub retry-proof regardless, and retries are
   disabled purely to keep the run fast and deterministic. If a 503 does not
   classify as transient at that boundary, that is a product finding to
   surface, not a test to bend.
4. **`daemon-lifecycle`** (`daemon.e2e.ts`; last plan task). `start` →
   `/health` responds → drop the happy-path ticket → `until(done/)` →
   `SIGTERM` → pidfile gone, exit clean. The only way to cover the singleton
   lock, signal handling, and health server across the process boundary.
   Flakiest by nature; polls via `until` with generous bounds; never gates the
   earlier tasks.

## 7. CI, packaging, live layer

### 7.1 CI

One step added to `env_gate` in `.github/workflows/quality-gate.yml`, on the
engines-floor (node 22.19) leg, after `npm test` and before
`package-smoke.sh`:

```yaml
- run: npm run test:e2e
```

Runs on both OSes (real seatbelt and real bwrap in the real process). Not on
the node-24 leg: the SDK wiring is what is under test and it does not vary by
node minor. `timeout-minutes: 25 → 30`. The required `quality-gate` check is
unchanged — it already depends on `env_gate`.

### 7.2 Packaging

`scripts/package-smoke.sh` gains, after its existing checks:

```bash
JUNCO_E2E_BIN="$JUNCO" npx vitest run -c vitest.e2e.config.ts tests/e2e/prFlow.e2e.ts -t pr-happy-path
```

run from the repo root (the script already `cd`s there). Selection is by FILE,
with `-t` as a secondary filter: `-t <slug>` alone exits 0 on zero matches, so
a renamed test would silently turn this check into a no-op, where a
non-existent file argument exits 1 ("No test files found") and actually fails
the smoke test. The tarball-installed binary runs the identical happy-path
scenario — no second harness — so a `files`-allowlist or bin-wiring regression
fails at full ticket depth.

### 7.3 Live layer

`tests/e2e/live.e2e.ts` uses the same harness with the stub replaced by
explicit env:

| var                   | meaning                                    |
| --------------------- | ------------------------------------------ |
| `JUNCO_E2E_LIVE=1`    | gate; the file is `describe.skipIf` otherwise |
| `JUNCO_E2E_MODEL_ID`  | provider-prefixed id, as `model.id`        |
| `JUNCO_E2E_BASE_URL`  | as `model.baseUrl`                         |
| `JUNCO_E2E_API_KEY`   | as `model.apiKey`                          |

The ticket is a tiny deterministic task ("create `hello.txt` containing
exactly `hello`"). Assertions are outcome-only: `done/`, branch exists, file
content matches. Timeout 10 min. Exposed as `npm run test:e2e:live`. Nothing
in the live file runs unless the gate var is set, so `npm run test:e2e` stays
hermetic.

## 8. Failure diagnostics and flake policy

A failed e2e test must be debuggable from CI logs alone. On failure the
harness prints: the child's exit code and the last 80 lines of stdout and
stderr; the queue state (dir + parsed frontmatter); the stub's request count
and `exhausted` flag; `gh.log`; and the sandbox path (retained only under
`JUNCO_E2E_KEEP=1`). Implemented as an `onTestFailed` hook registered by
`createSandbox`, so scenarios do not repeat it.

- Per-test timeout 120 s; the child is killed on expiry (§4.5).
- **No vitest retries.** An e2e flake is a real bug — in the harness or the
  product — and gets fixed, not retried into green.
- Ports come from `127.0.0.1:0`; nothing is hard-coded, so parallel local
  runs cannot collide.

## 9. Testing the infrastructure itself

The harness and stub are validated by the scenarios that use them — the first
failing `pr-happy-path` run is the TDD red for the stub. Two pieces get small
unit tests in the regular suite (precedent: `tests/helpersGhScript.test.ts`):

- the SSE chunk encoder (`encodeTurn(turn) → string[]`): a pure function that
  is easy to get subtly wrong (index bookkeeping across multi-call turns,
  `[DONE]` framing);
- the scrubbed-env builder (`childEnv(sb)`): the one function protecting the
  maintainer's live runtime — asserted directly that no inherited `JUNCO_*`,
  `HOME`, or `XDG_*` leaks through.

## 10. Verified facts this design rests on

| fact                                                                                                     | where                                                                           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| SDK talks OpenAI-compatible chat completions via the official `openai` client, streaming                  | `pi-ai/dist/api/openai-completions.js:139`                                      |
| `model.api` defaults to `"openai-completions"`; `model.baseUrl` configurable; unknown provider → inline   | `src/config.ts:340-341`, `src/agent/modelSetup.ts:171-190`                       |
| `junco run-once` processes one task, no lock, exit 0 after one attempt                                   | `src/cli.ts:805-830`                                                            |
| Bot-auth preflight is a no-op when `botAccount.enabled` is false (default)                               | `src/ghAuth.ts:86-93`, `src/config.ts:518-522`                                  |
| `git.ghBin`, `git.branchPrefix` (`junco/`), `git.defaultBaseBranch` (`main`)                             | `src/config.ts:414-417`                                                         |
| `sandbox.enabled` defaults true, fails closed without a backend                                          | `src/config.ts:438-443`                                                         |
| `worker.commitLeftovers` defaults false → the scripted agent must commit itself                          | `src/config.ts:392`                                                             |
| Q&A tickets get `cfg.tools ∩ {read,grep,find,ls}`; answer appended as `## Result`                        | `src/runOnce.ts:431`, `src/finalize.ts:33`                                      |
| `gh pr create --repo <nwo> --base <base> --head <branch>` must print a URL                               | `src/pr.ts:146-213`                                                             |
| `write` tool args are `{ path, content }`                                                                | `pi-coding-agent/dist/core/tools/write.js:12-14`                                |
| Transcripts on by default at `<dataDir>/data/transcripts/<id>.jsonl`                                     | `src/config.ts:483`, `CLAUDE.md` § Debugging                                    |
| Health server default port 8787, configurable via `observability.healthPort`                             | `src/config.ts:478`                                                             |

## 11. Risks and how the plan handles them

- **Registry resolution may need more than `/v1/models`.** If the inline path
  probes something else, the stub's 404-with-record surfaces the path in the
  first failing run; add the route then.
- **Sandbox path jail vs. the git clone.** The agent's `bash` runs jailed to
  the worktree under `<dataDir>/worktrees`; the `work` clone lives elsewhere
  in the sandbox. If the jail blocks something the flow legitimately needs,
  that is a product finding (the maintainer's own setup has the same shape).
- **`transient-requeue` classification.** Whether a 503 through the SDK's
  retry/backoff surfaces as transient is exactly what the test finds out; the
  scenario's assertion is written for the intended behavior and a mismatch is
  reported, not patched around.
- **CI time.** Three run-once scenarios plus daemon-lifecycle should add
  under two minutes per OS; the `timeout-minutes` bump gives headroom.
