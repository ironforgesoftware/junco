# Hosted AI providers: first-class support for metered cloud APIs

**Date:** 2026-07-11
**Status:** draft

## Problem

Junco today narrows the Pi SDK to a single inline OpenAI-compatible provider with
local-server defaults (`local/my-model @ http://127.0.0.1:1234/v1`, placeholder
key `"1234"`, qwen-flavored compat — `src/config.ts:77-95`). The SDK underneath
ships nine native hosted API implementations (Anthropic Messages, OpenAI
Completions/Responses/Codex, Google Gemini/Vertex, Bedrock, Azure, Mistral) on
official vendor SDKs, and `ModelRegistry.create()` / `ModelRegistry.inMemory()`
**unconditionally embed the full builtin catalog** — 1,029 models across 35
providers with correct `baseUrl`/`api`/`cost`/`contextWindow` (verified against
pi-coding-agent 0.80.3: `model-registry.js:264-312`). Junco's inline path
defeats it: `registerProvider` is called _before_ `find()` and replaces the
provider's entire builtin model set (`src/agent/session.ts:523-528`,
`model-registry.d.ts:93`), so `anthropic/claude-sonnet-4-5` today binds to
`http://127.0.0.1:1234/v1`.

Beyond resolution, four subsystems assume a free, un-metered, auth-less local
endpoint:

- **Auth**: `model.apiKey` is plaintext-only, always sent (`setRuntimeApiKey`
  at `src/agent/session.ts:504`), no env-var indirection anywhere.
- **Readiness**: the probe is an OpenAI-shaped `GET /models`
  (`src/health.ts:40-65`); a 401 from a bad hosted key reads as "endpoint
  down" and wedges claiming forever with no distinct surfacing (boot:
  `waitForEndpoint` blocks before the health server even binds,
  `src/daemon.ts:443`; post-boot: `src/runOnce.ts:136-143`). With the TUI open,
  probes fire ~3×/5s with no caching (`src/tui/App.tsx:919-934`,
  `src/tui/localSnapshot.ts:391,512,544`) — billed/rate-limited traffic hosted.
- **Failure classification**: `isTransientFailure` (`src/requeue.ts:24-30`) is
  a field-shape predicate — _any_ erroring zero-commit run counts as transient,
  so a permanent 401/quota error re-runs paid sessions until the retry budget
  (`maxTransientRetries` default 2) is burned, then fails the ticket.
- **Cost**: critic tokens appear nowhere (`src/critic.ts:175-191`); corrective
  tokens reach the transcript but not metrics or the ticket footer
  (`src/prFlow.ts:653-674`, `src/finalize.ts:58,226`); nothing computes dollars
  and no budget exists.

Two SDK behaviors discovered during verification also need closing regardless:
`AuthStorage.create()` file-backs onto the operator's real
`~/.pi/agent/auth.json` (creating it if absent), and omitting `settingsManager`
makes the SDK read `~/.pi/agent/settings.json` **and a trusted-by-default
`<worktree>/.pi/settings.json` from the target repo** — a repo-controlled
settings-injection surface for a queue worker that processes arbitrary repos.

## Key insight (scopes the feature)

This is not "build multi-provider support" — the SDK already has it. The work
is **un-narrowing**: let `ModelRegistry.find()` see the builtin catalog before
the inline path clobbers it, then make the queue's auth, readiness, failure,
and cost machinery honest about metered, auth-gated endpoints. No architecture
change; the `AgentSessionLike` seam, the pure `modelSetup.ts` layer, and the
ticket schema are untouched.

## Design

### 1. Resolution: a catalog path between models.json and inline

`makePiSessionFactory`'s cascade (`src/agent/session.ts:506-528`) gains a
middle step:

- **Path A (unchanged):** `models.json` when configured and present.
- **Path B (new, catalog):** when the resolved source is `catalog`, call
  `modelRegistry.find(provider, modelId)` on `ModelRegistry.inMemory(authStorage)`
  _without_ registering an inline provider — the builtin resolves with its real
  hosted `baseUrl`/`api`/`cost`/`contextWindow`. A miss falls through.
- **Path C (renamed, inline):** the existing `registerProvider` path.

**Source rule** (recorded at config assembly as `model.source`, values
`"auto" | "catalog" | "inline"`, default `auto`): under `auto`, the catalog
path is used iff the provider prefix is not `local` **and** the user did not
explicitly set `model.baseUrl` in their config file. An explicit `baseUrl`
always means inline (deliberate proxy/override). To know "explicitly set",
`model.baseUrl` becomes optional in the zod schema; assembly applies the local
default when absent and records `model.baseUrlExplicit: boolean` on the
resolved `Config`. Backward compatibility: bare ids default to provider
`local` (never a builtin), and provider-prefixed ids with an explicit baseUrl
stay inline — the only behavior change is provider-prefixed + no baseUrl,
which today silently binds to `127.0.0.1:1234` (a broken config, not a
workflow). CHANGELOG notes it.

`cfg.model.compat` (with its qwen-flavored defaults) is consumed only by the
inline path (`src/agent/modelSetup.ts:77`) — verified inert for Paths A/B; no
change needed. Catalog models carry their own compat or auto-detect. Users
needing compat overrides on a hosted model use models.json or inline.

Same-provider multi-model works naturally: `plannerModelId` resolves through
the same registry and shares the runtime key. A planner on a _different_
provider resolves via env-key fallback (see §2) — documented, not specially
wired.

### 2. Auth: optional key, `$VAR` indirection, no ambient files

- `model.apiKey` becomes optional. Resolution at config assembly:
  - Literal string → used as-is (current behavior; local default `"1234"`
    applies only when the source is inline/local).
  - `"$VAR"` (exact pattern `^\$[A-Z_][A-Z0-9_]*$`) → interpolated from the
    daemon's environment at assembly; missing var is a config **error** at
    load, not a silent empty key.
  - Absent (hosted) → `setRuntimeApiKey` is skipped and the SDK's native
    request-time env resolution takes over (`ANTHROPIC_API_KEY`,
    `OPENAI_API_KEY`, `GEMINI_API_KEY`, … — pi-ai `env-api-keys.js:60-103`).
  - `"!command"` values are **rejected** at validation with a clear error. The
    SDK executes `!`-prefixed auth/provider config values as shell commands
    (`resolve-config-value.js:159-188`); junco will not forward that surface
    from its own config file.
- The session factory stops file-backing the operator's `~/.pi/agent/auth.json`:
  prefer an in-memory `AuthStorage` if the SDK exposes one; if not, point
  `AuthStorage` at a junco-owned path under `state_dir` (investigation task —
  either way, junco must stop creating/touching the user's real pi auth file).
- The factory **always** passes `SettingsManager.inMemory(...)` to
  `createAgentSession`, closing the ambient `~/.pi/agent/settings.json` and
  repo-controlled `<worktree>/.pi/settings.json` reads. This is also where the
  SDK's retry knobs become junco levers: `model.retry.maxRetries`,
  `model.retry.baseDelayMs` (optional, SDK defaults otherwise).
- Wizard writes `"$ANTHROPIC_API_KEY"`-style references by default (per-provider
  env-var name from the SDK's map) and uses a masked prompt (`p.password`) when
  the user insists on pasting a literal; pasted literals get a file-permissions
  warning. `model.apiKey` is already a `secret`-masked lever in TUI/CLI.
- `scrubEnv` already strips key-shaped env vars from agent-visible child
  processes (allowlist model, `src/scrubEnv.ts:8-30`) — provider keys in the
  daemon env do not leak into sandboxed bash or verify blocks. A test pins
  `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` specifically.

### 3. Provider gate: one enum replaces the reachability boolean

A single state consumed by the claim gate, `/health`, `/ready`, TUI, and logs:

```
ok | unreachable | auth_error | quota_exhausted | rate_limited(until) | budget_exhausted | misconfig
```

- **Probing** (`worker.endpointProbe: "auto" | "always" | "never"`, default
  `auto`): `auto` probes local/inline endpoints exactly as today but does
  **not** probe catalog-resolved hosted endpoints — for hosted, the gate is
  driven by in-session outcomes instead (a probe can't distinguish "down" from
  "key revoked" without spending rate limit, and the TUI's 3-sources-per-5s
  probe pattern is billed traffic). Probe results get a short TTL cache
  (~10 s) shared across the health server, TUI cheap-poll, and claim gate, so
  local mode stops triple-probing too (`src/tui/localSnapshot.ts:391` must
  respect both the cache and the hosted skip). `waitForEndpoint` boot-blocking
  becomes a no-op for hosted sources, and its "unreachable" log stops
  mislabeling auth failures.
- **In-session classification** (new `src/providerFailure.ts`, pure):
  `classifyProviderFailure(errorText)` → `auth | quota | model_not_found |
rate_limit | outage | unknown`, matching on the status/text patterns the SDK
  itself flattens into `finalError` strings (its own retry layer matches
  `429/rate limit/overloaded/5xx` and excludes `insufficient_quota` — junco
  mirrors those patterns; there is no structured status code in the event
  stream, verified). One capture fix feeds it: first-attempt non-retryable
  errors never emit `auto_retry_end`, so `runResult` must also capture the
  assistant message's `errorMessage` (today it can end `stopReason:"error"`
  with `errorMessage:null`).
- **Routing**: `auth`, `quota`, and `model_not_found` are infrastructure
  problems, not ticket problems — the ticket goes back to `inbox/` with
  `not_before` stamped but `retry_count` **unchanged** (assembled from the
  exported `upsertFrontmatterKey`, `src/requeue.ts:37-46`, plus the poller's
  count-independent `not_before` gate, `src/runOnce.ts:126-133`; no such
  primitive exists today — orphan recovery burns the budget), and the gate
  latches loud (`auth_error` etc.) until a config hot-reload or daemon restart
  clears it. `rate_limit` requeues the same count-free way with exponential
  `not_before` backoff (base `worker.retryBackoffSeconds`, doubling per
  consecutive rate-limited attempt, capped at 15 minutes) and gates claiming
  until it passes. `outage` keeps the
  existing transient path (count-incrementing requeue). `unknown` keeps
  today's behavior exactly.
- **Surfacing**: `/health` gains `gate: {state, reason, since}`; `/ready` 503
  body says _why_; the TUI dot gets state-specific color + reason line; a
  metrics counter per gate-state transition. Auth failures stop presenting as
  outages anywhere.

### 4. Cost: count everything, compute dollars, optional budget

- **Count everything**: ticket-level usage aggregates the main run + critic
  pass(es) + corrective run (today: critic tokens appear nowhere, corrective
  tokens transcript-only, and a corrective retry triggers a second uncounted
  critic pass). The aggregate flows to the ticket footer, transcript, and
  metrics.
- **Dollars**: the session factory knows the resolved `Model` object; it
  exposes the model's `cost` table (catalog models carry real per-Mtok rates;
  inline uses `model.cost.*`) so finalize/metrics can compute per-ticket USD
  without touching the SDK. Cumulative and per-day USD land in metrics,
  `/health`, and the TUI header.
- **Budget**: `worker.dailyBudgetUsd` (default 0 = off). When the day's spend
  crosses it, the gate latches `budget_exhausted` (claiming pauses, loud) until
  local midnight or a config change. Day counter persists under `state_dir`.
  Report-only remains the default posture; the budget is the opt-in kill
  switch.

### 5. Product surface: doctor, wizard, TUI, docs

- **Doctor** becomes provider-aware: echoes the resolution path
  (models.json / catalog / inline) and key source (config literal / `$VAR` /
  env var / none); checks the model id against the catalog; runs a per-API
  auth check using each API family's free authenticated list-models route
  (`openai-*` → `GET /models` Bearer; `anthropic-messages` → `GET /v1/models`
  x-api-key; `google-*` → `GET /v1beta/models?key=`); preflights
  `plannerModelId` the same way. No paid completions calls.
- **Wizard** mode select (`src/wizard.ts:93-99`) gains a third branch:
  _hosted provider_ → provider picker sourced from the SDK's builtin provider
  list (complete, alphabetical — no favorites) → model picker from the catalog
  filtered to that provider → key setup per §2 defaults.
- **TUI**: config fields flow automatically from `LEVERS` + `SECTION_ORDER`;
  adds the gate state + reason and the spend ticker to the dashboard.
- **SDK-import discipline**: doctor and wizard need the catalog at runtime,
  but the repo rule keeps dynamic SDK imports in one place — `session.ts`
  exports a `loadSdkSurface()` helper (the factory, doctor, and wizard all
  consume it; tests inject fakes). The CLAUDE.md rule is amended from "only
  inside `makePiSessionFactory`" to "only inside `src/agent/session.ts`".
- **Docs**: README/ARCHITECTURE's "any OpenAI-compatible inference endpoint"
  becomes "any endpoint or hosted provider the embedded SDK supports";
  `docs/configuration.md` gains a hosted section; `examples/` gains a hosted
  config variant; `docs/tickets.md` documents the new failure classes.
  **Stack-agnostic carve-out**: the shipping rule ("inference endpoint", never
  a specific server) stays for _local/personal_ setups; hosted provider names
  are permitted in shipped text when enumerated from the SDK's catalog rather
  than hand-picked. Local-first remains the README's default path; hosted is
  the documented first-class alternative.

## Non-goals (follow-up issues, not this feature)

- Ambient-credential providers (Bedrock, Vertex — need an absent-key _and_
  vendor-SDK credential story; the key-based 30+ providers land first).
- OAuth subscription auth (Claude Pro/Max, Codex).
- Cross-provider per-role models beyond the env-key fallback (explicit
  per-role provider/key config).
- An inter-session rate limiter for `maxConcurrent > 1`.
- Binding the health server before `waitForEndpoint` at boot (diagnosability
  fix, orthogonal).

## Testing

Pure units for the new seams (`classifyProviderFailure`, source rule, `$VAR`
interpolation and `!` rejection, gate state machine, USD math, count-free
requeue). Factory tests against fake registries via the existing
`AgentSessionLike`/injected-deps pattern — no SDK import in tests; an
sdkImportSurface-style test pins `SettingsManager` (and the auth-storage
choice) on the root export. Doctor/health tests with fake fetch. Wizard tests
through the existing prompt harness. Config-fixture sweep across the six
`makeConfig` helpers (schema changes are additive but the resolved type gains
fields). TUI assertions loop-until-condition per the repo rule.

## Phasing (three PRs, each independently green and shippable)

1. **Core resolution + auth** (§1, §2): catalog path, source rule, optional
   `$VAR` apiKey, no ambient auth/settings files, retry levers. Usable by hand
   after this PR ("dark launch").
2. **Resilience** (§3): error capture fix, classification, provider gate,
   count-free requeue, probe skip/TTL.
3. **Product surface + cost** (§4, §5): doctor, wizard, TUI, cost accounting,
   budget, docs.
