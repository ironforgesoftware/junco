# Junco's Own GitHub Account (Bot Identity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All daemon GitHub traffic (PR create/push/comment/labels, bridge polling, outbox replay) runs as a dedicated machine account whose credential lives in an isolated `GH_CONFIG_DIR`; interactive commands stay under the operator's personal `gh` login.

**Architecture:** A `GhAuthContext` (config dir + bot login + noreply email + git credential helper) is resolved once at daemon startup by the new `src/ghAuth.ts` and attached to `Config` as an optional runtime field. The `gh()`/`git()` wrappers in `src/git.ts` inject `GH_CONFIG_DIR` (and a pinned credential helper for git) into child env when the field is present. Entrypoints decide who gets it: `start`/`run-once` attach (and refuse to start if enabled-but-unresolvable); interactive commands don't; dispatch-time fork provisioning attaches explicitly. Commit identity is seeded per-worktree via `extensions.worktreeConfig`. Spec: `docs/superpowers/specs/2026-07-15-gh-bot-account-design.md`.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), zod config schema, vitest, Ink 7 (wizard chapter), no new dependencies.

## Global Constraints

- No AI attribution in commits, ever (no `Co-Authored-By: Claude`, no "Generated with"). Subagent commits auto-append the trailer — amend it away.
- Conventional commits (`feat:`, `fix:`, `docs:`, scope optional); suite green at every commit.
- Exact-pinned deps only — this plan adds **none**.
- Never import the Pi SDK at module top level in `src/` (this plan never touches SDK imports).
- All user-visible strings stay stack-agnostic ("inference endpoint", never a personal server name).
- `config.json`, `tickets/`, `worktrees/` at the ORIGINAL repo root are live runtime state — never touch them; all smoke tests go through a sandboxed `$SB` dir per CLAUDE.md.
- Exit-code trap: never pipe vitest into a filter; run `npx vitest run tests/<file>.test.ts > /tmp/out 2>&1; echo "exit: $?"` and read the file.
- Prettier may reformat between read and edit — re-read before editing, run `npx prettier --write` on touched files before committing.
- Ink/TUI tests: never assert one fixed `setTimeout` tick after a state change — loop-until-condition with bounded retry.
- **Adding Config fields (Task 1) breaks every test fixture that builds a full `Config` literal** — `tests/{runOnce,prFlow,orphans,repo,worktree,daemon}.test.ts` and possibly others have `makeConfig`/`cfg()` helpers. `npm run typecheck` (via `tsconfig.eslint.json`) is the catch-all; run it after Task 1 and fix every fixture. (~57 pre-existing errors in the sweep output are known noise per project memory — only fix NEW ones.)

---

### Task 1: Config surface — `botAccount` block, `GhAuthContext` type, levers

**Files:**

- Modify: `src/types.ts` (Config interface at :81, add two interfaces near `GithubConfig` at :50)
- Modify: `src/config.ts` (ConfigSchema at :123, assembleConfig at :332)
- Modify: `src/configLevers.ts` (LEVERS array — add two entries after the `github.*` group, ~:626)
- Modify: every test fixture building a full `Config` literal (typecheck reveals them)
- Test: `tests/config.test.ts`, `tests/configLevers.test.ts`

**Interfaces:**

- Consumes: nothing (first task).
- Produces:
  - `types.ts`: `interface BotAccountConfig { enabled: boolean; configDir: string }`; `interface GhAuthContext { configDir: string; login: string; email: string; credentialHelper: string }`; `Config` gains `botAccount: BotAccountConfig` and `ghAuth?: GhAuthContext`.
  - Schema default: `botAccount: { enabled: false, configDir: "~/.config/junco/gh" }`, configDir tilde-expanded in `assembleConfig`.

- [ ] **Step 1: Write the failing tests**

In `tests/config.test.ts`, add (following the file's existing parse/assemble test style):

```ts
describe("botAccount config", () => {
  it("defaults to disabled with the standard config dir", () => {
    const cfg = assembleConfig(ConfigSchema.parse({ vaultRoot: "/tmp/v" }));
    expect(cfg.botAccount.enabled).toBe(false);
    expect(cfg.botAccount.configDir).toBe(expandHome("~/.config/junco/gh"));
    expect(cfg.ghAuth).toBeUndefined();
  });

  it("expands ~ in botAccount.configDir and honors enabled", () => {
    const cfg = assembleConfig(
      ConfigSchema.parse({
        vaultRoot: "/tmp/v",
        botAccount: { enabled: true, configDir: "~/custom/gh" },
      }),
    );
    expect(cfg.botAccount.enabled).toBe(true);
    expect(cfg.botAccount.configDir).toBe(expandHome("~/custom/gh"));
  });
});
```

In `tests/configLevers.test.ts`, add assertions that `LEVERS` contains `botAccount.enabled` (boolean, restart) and `botAccount.configDir` (string, restart) — follow the file's existing lever-presence test pattern. If the file pins a total lever count, bump it by 2.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts tests/configLevers.test.ts > /tmp/t1.out 2>&1; echo "exit: $?"`
Expected: FAIL — `botAccount` does not exist on the parsed/assembled config.

- [ ] **Step 3: Implement**

`src/types.ts` — next to `GithubConfig`:

```ts
/** [botAccount] — dedicated machine-account identity for daemon GitHub traffic. */
export interface BotAccountConfig {
  enabled: boolean; // false = today's ambient-gh-auth behavior
  configDir: string; // isolated GH_CONFIG_DIR holding the bot login (expanded)
}

/** Runtime-resolved bot auth context (src/ghAuth.ts) — attached to Config by
 * entrypoints, never parsed from config.json. Carried by cfg into git()/gh()
 * so child processes authenticate as the bot. */
export interface GhAuthContext {
  configDir: string; // GH_CONFIG_DIR for child gh/git processes
  login: string; // bot account login
  email: string; // <id>+<login>@users.noreply.github.com
  credentialHelper: string; // "!<ghBin> auth git-credential" (inherits child env)
}
```

In `interface Config`, after `sandbox: SandboxConfig;`:

```ts
  // Dedicated bot identity for daemon GitHub traffic (spec 2026-07-15).
  botAccount: BotAccountConfig;
  // Resolved at entrypoints when botAccount.enabled — NOT part of config.json.
  ghAuth?: GhAuthContext;
```

`src/config.ts` — in `ConfigSchema` after the `assess` block:

```ts
  botAccount: z
    .object({
      enabled: z.boolean().default(false),
      configDir: z.string().min(1).default("~/.config/junco/gh"),
    })
    .default({}),
```

In `assembleConfig`'s returned object, after `sandbox: {...}`:

```ts
    botAccount: {
      enabled: d.botAccount.enabled,
      configDir: expandHome(d.botAccount.configDir),
    },
```

`src/configLevers.ts` — after the last `github.*` lever:

```ts
  // --- botAccount.* ---
  {
    path: "botAccount.enabled",
    type: "boolean",
    default: false,
    editable: true,
    reload: "restart",
    description:
      "Act as a dedicated bot account for all daemon GitHub traffic (log it in with: junco auth login).",
  },
  {
    path: "botAccount.configDir",
    type: "string",
    default: "~/.config/junco/gh",
    editable: true,
    reload: "restart",
    description: "Isolated gh config dir holding the bot login (GH_CONFIG_DIR for daemon gh/git).",
  },
```

- [ ] **Step 4: Fix every full-Config test fixture**

Run: `npx tsc --noEmit -p tsconfig.eslint.json > /tmp/tc1.out 2>&1; echo "exit: $?"` then read `/tmp/tc1.out`. Every NEW error is a fixture missing the field — add to each `makeConfig`/`cfg()` literal:

```ts
    botAccount: { enabled: false, configDir: "/tmp/junco-gh" },
```

(Only fix errors introduced by this change; ~57 pre-existing sweep errors are known noise.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts tests/configLevers.test.ts > /tmp/t1.out 2>&1; echo "exit: $?"`
Expected: PASS. Then the full suite: `npx vitest run > /tmp/full1.out 2>&1; echo "exit: $?"` — PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/types.ts src/config.ts src/configLevers.ts
git add -A && git commit -m "feat(config): botAccount block + GhAuthContext runtime field"
```

---

### Task 2: The auth seam — env injection in `runCmd`/`gh()`/`git()`

**Files:**

- Modify: `src/git.ts` (RunOpts at :40, runCmd spawn at :61, git() at :213, gh() at :232)
- Test: `tests/git.test.ts`

**Interfaces:**

- Consumes: `GhAuthContext` from `src/types.ts` (Task 1).
- Produces:
  - `RunOpts` gains `env?: Record<string, string>` (merged OVER `process.env` for the child).
  - `export function ghAuthEnv(ctx: GhAuthContext): Record<string, string>` — `{ GH_CONFIG_DIR, GIT_TERMINAL_PROMPT: "0" }`.
  - `gh(cfg: { ghBin: string; ghAuth?: GhAuthContext }, args, opts?)` — injects `ghAuthEnv` when `cfg.ghAuth` present.
  - `git(cfg: { gitBin: string; ghAuth?: GhAuthContext }, args, opts?)` — injects `ghAuthEnv` AND prepends `["-c", "credential.helper=", "-c", "credential.helper=" + ctx.credentialHelper]` to args (clear inherited helpers, pin gh's; the helper subprocess inherits the child's `GH_CONFIG_DIR`).
  - Every existing caller compiles unchanged (the added cfg fields are optional; full `Config` satisfies them structurally).

- [ ] **Step 1: Write the failing tests**

In `tests/git.test.ts`, add (uses the file's existing tmp-dir/fake-script conventions; `mkdtempSync`, `writeFileSync`, `chmodSync` are already imported or trivially added):

```ts
import { gh, git, ghAuthEnv } from "../src/git.js";
import type { GhAuthContext } from "../src/types.js";

const CTX: GhAuthContext = {
  configDir: "/sbx/junco-gh",
  login: "junco-agent",
  email: "1234+junco-agent@users.noreply.github.com",
  credentialHelper: "!gh auth git-credential",
};

function writeEnvEcho(path: string): void {
  writeFileSync(
    path,
    `#!/bin/sh\necho "cfgdir=\${GH_CONFIG_DIR:-unset} prompt=\${GIT_TERMINAL_PROMPT:-unset}"\necho "argv=$*"\n`,
    "utf8",
  );
  chmodSync(path, 0o755);
}

describe("bot auth env injection", () => {
  it("ghAuthEnv builds the child env pair", () => {
    expect(ghAuthEnv(CTX)).toEqual({
      GH_CONFIG_DIR: "/sbx/junco-gh",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("gh() injects GH_CONFIG_DIR when cfg carries ghAuth, not otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-git-test-"));
    const fake = join(dir, "fake-gh");
    writeEnvEcho(fake);
    const withAuth = await gh({ ghBin: fake, ghAuth: CTX }, ["api", "user"]);
    expect(withAuth.stdout).toContain("cfgdir=/sbx/junco-gh");
    expect(withAuth.stdout).toContain("prompt=0");
    const without = await gh({ ghBin: fake }, ["api", "user"]);
    expect(without.stdout).toContain("cfgdir=unset");
  });

  it("git() injects env AND pins the credential helper before the subcommand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-git-test-"));
    const fake = join(dir, "fake-git");
    writeEnvEcho(fake);
    const r = await git({ gitBin: fake, ghAuth: CTX }, ["push", "origin", "b"]);
    expect(r.stdout).toContain("cfgdir=/sbx/junco-gh");
    expect(r.stdout).toContain(
      "argv=-c credential.helper= -c credential.helper=!gh auth git-credential push origin b",
    );
    const plain = await git({ gitBin: fake }, ["push", "origin", "b"]);
    expect(plain.stdout).toContain("argv=push origin b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/git.test.ts > /tmp/t2.out 2>&1; echo "exit: $?"`
Expected: FAIL — `ghAuthEnv` is not exported.

- [ ] **Step 3: Implement**

`src/git.ts`:

Add to imports: `import type { GhAuthContext } from "./types.js";`

`RunOpts` gains:

```ts
  /** Extra child env, merged OVER process.env (bot auth injection point). */
  env?: Record<string, string>;
```

In `runCmd`, the spawn call becomes:

```ts
proc = spawn(bin, args, {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
  env: opts.env ? { ...process.env, ...opts.env } : undefined,
});
```

(destructure `env` is NOT needed — read `opts.env` directly; keep the existing `const { cwd, timeoutMs = 120_000, check = true } = opts;`.)

New helper above `git()`:

```ts
/** Child-env pair for bot-authenticated gh/git calls: point gh (and gh's git
 * credential helper, which inherits the child env) at the bot's isolated
 * config dir, and forbid interactive credential prompts so a missing token
 * fails loud instead of hanging a daemon subprocess. */
export function ghAuthEnv(ctx: GhAuthContext): Record<string, string> {
  return { GH_CONFIG_DIR: ctx.configDir, GIT_TERMINAL_PROMPT: "0" };
}
```

`git()` becomes:

```ts
export async function git(
  cfg: { gitBin: string; ghAuth?: GhAuthContext },
  args: string[],
  opts?: GitCallOpts,
): Promise<CmdResult> {
  const { retryNetwork, retryBaseDelayMs, ...runOpts } = opts ?? {};
  // Bot mode: pin gh's credential helper (clearing any inherited helpers) so
  // remote ops authenticate as the bot regardless of the user's global
  // gitconfig. Harmless on local-only ops. `-c` flags are global — they must
  // precede the subcommand.
  const authArgs = cfg.ghAuth
    ? ["-c", "credential.helper=", "-c", `credential.helper=${cfg.ghAuth.credentialHelper}`]
    : [];
  const argv = [cfg.gitBin, ...authArgs, ...args];
  const label = `git ${args[0] ?? ""}`;
  const finalOpts = cfg.ghAuth
    ? { ...runOpts, env: { ...ghAuthEnv(cfg.ghAuth), ...runOpts.env } }
    : runOpts;

  if (retryNetwork) {
    return runWithRetry(label, () => runCmd(argv, finalOpts), { baseDelayMs: retryBaseDelayMs });
  }
  return runCmd(argv, finalOpts);
}
```

`gh()` becomes:

```ts
export async function gh(
  cfg: { ghBin: string; ghAuth?: GhAuthContext },
  args: string[],
  opts?: GitCallOpts,
): Promise<CmdResult> {
  const { retryNetwork, retryBaseDelayMs, ...runOpts } = opts ?? {};
  const argv = [cfg.ghBin, ...args];
  const label = `gh ${args.slice(0, 2).join(" ")}`;
  const finalOpts = cfg.ghAuth
    ? { ...runOpts, env: { ...ghAuthEnv(cfg.ghAuth), ...runOpts.env } }
    : runOpts;

  if (retryNetwork) {
    return runWithRetry(label, () => runCmd(argv, finalOpts), { baseDelayMs: retryBaseDelayMs });
  }
  return runCmd(argv, finalOpts);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/git.test.ts > /tmp/t2.out 2>&1; echo "exit: $?"` — PASS.
Then full suite (`gh`/`git` are load-bearing everywhere): `npx vitest run > /tmp/full2.out 2>&1; echo "exit: $?"` — PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/git.ts tests/git.test.ts
git add -A && git commit -m "feat(git): bot-auth env seam — GH_CONFIG_DIR + pinned credential helper"
```

---

### Task 3: `src/ghAuth.ts` — resolution, attach, login, detect

**Files:**

- Create: `src/ghAuth.ts`
- Test: `tests/ghAuth.test.ts` (create)

**Interfaces:**

- Consumes: `Config`, `GhAuthContext` (Task 1); `defaultExec` shape from `src/execProbe.ts` (Task 8 widens it; until then this module declares its own exec type with env support).
- Produces (exact signatures later tasks call):
  - `export const DEFAULT_GH_CONFIG_DIR = "~/.config/junco/gh";`
  - `export interface GhAuthDeps { execFn?: (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => Promise<{ code: number; stdout: string; stderr: string }>; spawnFn?: typeof spawn; }`
  - `export async function resolveBotAuth(cfg: Pick<Config, "botAccount" | "ghBin">, deps?: GhAuthDeps): Promise<GhAuthContext | null>` — null when disabled; throws with an actionable message when enabled but the login is missing/expired.
  - `export async function withBotAuth<C extends Pick<Config, "botAccount" | "ghBin">>(cfg: C, deps?: GhAuthDeps): Promise<C & { ghAuth?: GhAuthContext }>` — returns cfg unchanged when disabled, `{ ...cfg, ghAuth }` when enabled; propagates resolveBotAuth's throw.
  - `export async function detectBotLogin(ghBin: string, configDir: string, deps?: GhAuthDeps): Promise<string | null>` — login or null, never throws (wizard probe).
  - `export function runGhLogin(ghBin: string, configDir: string, deps?: GhAuthDeps): Promise<number>` — spawns `gh auth login --hostname github.com --git-protocol https --web` with `stdio: "inherit"` and `GH_CONFIG_DIR` set; creates configDir (mode 0o700) first; resolves with exit code.

- [ ] **Step 1: Write the failing tests**

Create `tests/ghAuth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveBotAuth, withBotAuth, detectBotLogin } from "../src/ghAuth.js";

const USER_JSON = JSON.stringify({ login: "junco-agent", id: 987654 });

function fakeExec(script: Record<string, { code: number; stdout: string }>) {
  const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
  const execFn = async (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
    calls.push({ cmd, args, env: opts?.env });
    const key = args.join(" ");
    const hit = script[key] ?? { code: 1, stdout: "" };
    return { code: hit.code, stdout: hit.stdout, stderr: "" };
  };
  return { execFn, calls };
}

const ENABLED = {
  botAccount: { enabled: true, configDir: "/sbx/junco-gh" },
  ghBin: "gh",
};

describe("resolveBotAuth", () => {
  it("returns null (and execs nothing) when disabled", async () => {
    const { execFn, calls } = fakeExec({});
    const ctx = await resolveBotAuth(
      { botAccount: { enabled: false, configDir: "/sbx/junco-gh" }, ghBin: "gh" },
      { execFn },
    );
    expect(ctx).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("resolves login, noreply email, and credential helper under GH_CONFIG_DIR", async () => {
    const { execFn, calls } = fakeExec({ "api user": { code: 0, stdout: USER_JSON } });
    const ctx = await resolveBotAuth(ENABLED, { execFn });
    expect(ctx).toEqual({
      configDir: "/sbx/junco-gh",
      login: "junco-agent",
      email: "987654+junco-agent@users.noreply.github.com",
      credentialHelper: "!gh auth git-credential",
    });
    expect(calls[0].env).toEqual({ GH_CONFIG_DIR: "/sbx/junco-gh" });
  });

  it("throws an actionable error when enabled but not logged in", async () => {
    const { execFn } = fakeExec({}); // api user → exit 1
    await expect(resolveBotAuth(ENABLED, { execFn })).rejects.toThrow(/junco auth login/);
  });
});

describe("withBotAuth", () => {
  it("attaches ghAuth when enabled, passes through when disabled", async () => {
    const { execFn } = fakeExec({ "api user": { code: 0, stdout: USER_JSON } });
    const on = await withBotAuth({ ...ENABLED }, { execFn });
    expect(on.ghAuth?.login).toBe("junco-agent");
    const offCfg = { botAccount: { enabled: false, configDir: "/x" }, ghBin: "gh" };
    const off = await withBotAuth(offCfg, { execFn });
    expect(off).toBe(offCfg);
  });
});

describe("detectBotLogin", () => {
  it("returns the login when authed, null when not (never throws)", async () => {
    const ok = fakeExec({ "api user": { code: 0, stdout: USER_JSON } });
    expect(await detectBotLogin("gh", "/sbx/junco-gh", { execFn: ok.execFn })).toBe("junco-agent");
    const bad = fakeExec({});
    expect(await detectBotLogin("gh", "/sbx/junco-gh", { execFn: bad.execFn })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ghAuth.test.ts > /tmp/t3.out 2>&1; echo "exit: $?"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/ghAuth.ts`:

```ts
/**
 * Bot-account auth resolution (spec 2026-07-15-gh-bot-account-design.md).
 * The bot's credential is a normal `gh auth login` living in an ISOLATED
 * GH_CONFIG_DIR (default ~/.config/junco/gh) — gh owns token refresh; junco
 * only ever handles the dir path, never the token. Entrypoints call
 * withBotAuth() to attach the resolved GhAuthContext to Config; git.ts injects
 * it into child env (see ghAuthEnv).
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import type { Config, GhAuthContext } from "./types.js";

export const DEFAULT_GH_CONFIG_DIR = "~/.config/junco/gh";

/** Same shape as execProbe's defaultExec, plus env (bot probes need it). */
function defaultExecWithEnv(
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: 10_000, env: opts?.env ? { ...process.env, ...opts.env } : undefined },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export interface GhAuthDeps {
  execFn?: (
    cmd: string,
    args: string[],
    opts?: { env?: Record<string, string> },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  spawnFn?: typeof spawn;
  mkdirFn?: (p: string) => void;
}

/** Resolve the bot identity under botAccount.configDir. `null` when disabled;
 * throws (actionable) when enabled but the login is missing or expired —
 * silent fallback to the operator's personal identity would be an attribution
 * and self-approval hazard, so callers fail loud. */
export async function resolveBotAuth(
  cfg: Pick<Config, "botAccount" | "ghBin">,
  deps: GhAuthDeps = {},
): Promise<GhAuthContext | null> {
  if (!cfg.botAccount.enabled) return null;
  const execFn = deps.execFn ?? defaultExecWithEnv;
  const r = await execFn(cfg.ghBin, ["api", "user"], {
    env: { GH_CONFIG_DIR: cfg.botAccount.configDir },
  });
  if (r.code !== 0) {
    throw new Error(
      `botAccount.enabled is true but no working gh login exists under ` +
        `${cfg.botAccount.configDir} — run: junco auth login (or set botAccount.enabled=false)`,
    );
  }
  let login: string;
  let id: number;
  try {
    const u = JSON.parse(r.stdout) as { login: string; id: number };
    login = u.login;
    id = u.id;
  } catch {
    throw new Error(`bot account: could not parse 'gh api user' output (${r.stdout.slice(0, 80)})`);
  }
  return {
    configDir: cfg.botAccount.configDir,
    login,
    email: `${id}+${login}@users.noreply.github.com`,
    // The helper subprocess is spawned by git and inherits the child's
    // GH_CONFIG_DIR (ghAuthEnv), so the bare gh binary reference suffices.
    credentialHelper: `!${cfg.ghBin} auth git-credential`,
  };
}

/** Attach the resolved context to cfg (spread copy). Disabled → cfg unchanged. */
export async function withBotAuth<C extends Pick<Config, "botAccount" | "ghBin">>(
  cfg: C,
  deps: GhAuthDeps = {},
): Promise<C & { ghAuth?: GhAuthContext }> {
  const ctx = await resolveBotAuth(cfg, deps);
  if (ctx === null) return cfg;
  return { ...cfg, ghAuth: ctx };
}

/** Wizard/doctor probe: bot login under configDir, or null. Never throws. */
export async function detectBotLogin(
  ghBin: string,
  configDir: string,
  deps: GhAuthDeps = {},
): Promise<string | null> {
  const execFn = deps.execFn ?? defaultExecWithEnv;
  try {
    const r = await execFn(ghBin, ["api", "user"], { env: { GH_CONFIG_DIR: configDir } });
    if (r.code !== 0) return null;
    return (JSON.parse(r.stdout) as { login: string }).login ?? null;
  } catch {
    return null;
  }
}

/** The ONE interactive login routine (shared by `junco auth login` and the
 * wizard Account chapter): gh's own device-flow UX with inherited stdio,
 * pointed at the isolated config dir. Resolves with gh's exit code. */
export function runGhLogin(
  ghBin: string,
  configDir: string,
  deps: GhAuthDeps = {},
): Promise<number> {
  const spawnFn = deps.spawnFn ?? spawn;
  const mkdirFn = deps.mkdirFn ?? ((p: string) => mkdirSync(p, { recursive: true, mode: 0o700 }));
  mkdirFn(configDir);
  return new Promise((resolve) => {
    const child = spawnFn(
      ghBin,
      ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"],
      { stdio: "inherit", env: { ...process.env, GH_CONFIG_DIR: configDir } },
    );
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ghAuth.test.ts > /tmp/t3.out 2>&1; echo "exit: $?"` — PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/ghAuth.ts tests/ghAuth.test.ts
git add -A && git commit -m "feat(ghAuth): bot identity resolution, attach, detect, shared login routine"
```

---

### Task 4: planLint env threading (the last gh bypass)

**Files:**

- Modify: `src/planLint.ts` (`_fetchRepoLabels` at :411, `checkLabelsExist` opts at :439-446, `lintTicket` at :519)
- Modify: `src/prFlow.ts` (lintTicket call at :409-414)
- Test: `tests/planLint.test.ts`

**Interfaces:**

- Consumes: `ghAuthEnv` from `src/git.ts` (Task 2); `cfg.ghAuth` (Task 1).
- Produces: `lintTicket(body, frontmatter, opts)` and `checkLabelsExist(...)` accept `ghEnv?: Record<string, string>`; `_fetchRepoLabels(nwo, ghBin, ghEnv?)` passes `{ env: { ...process.env, ...ghEnv } }` to `execFileSync`.
- **Spec amendment (documented here, echo it in the PR):** the spec said "migrate `_fetchRepoLabels` onto the `gh()` wrapper", but `lintTicket` is synchronous and widely called — asyncifying the whole lint API for one read-only call is disproportionate. Env threading achieves the identical auth outcome (same `GH_CONFIG_DIR` as every other daemon gh call) with zero API ripple.

- [ ] **Step 1: Write the failing test**

In `tests/planLint.test.ts`, add (the file already writes fake gh scripts and drives `lintTicket` with `ghBin` — follow its conventions):

```ts
it("threads ghEnv into the label fetch (bot GH_CONFIG_DIR)", () => {
  const dir = mkdtempSync(join(tmpdir(), "junco-planlint-"));
  const fake = join(dir, "fake-gh");
  const out = join(dir, "env.txt");
  writeFileSync(
    fake,
    `#!/bin/sh\necho "\${GH_CONFIG_DIR:-unset}" > ${JSON.stringify(out)}\necho "bug"\n`,
    "utf8",
  );
  chmodSync(fake, 0o755);
  const violations = lintTicket(
    "# t\n\n- [ ] step",
    { labels: ["bug"], repo: "/r" },
    {
      ghBin: fake,
      ghEnv: { GH_CONFIG_DIR: "/sbx/junco-gh" },
      repoNwo: "owner/repo",
    },
  );
  expect(readFileSync(out, "utf8").trim()).toBe("/sbx/junco-gh");
  void violations;
});
```

(Adapt the `lintTicket` argument shape to the file's existing label-check tests — the essential assertions are the env file contents and that a `ghEnv`-free call still works.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/planLint.test.ts > /tmp/t4.out 2>&1; echo "exit: $?"`
Expected: FAIL — `ghEnv` is not a known option (TS error at test compile) or env file says "unset".

- [ ] **Step 3: Implement**

`src/planLint.ts`:

```ts
function _fetchRepoLabels(
  nwo: string,
  ghBin = "gh",
  ghEnv?: Record<string, string>,
): Set<string> {
  // ... (docstring unchanged, plus:) `ghEnv` merges over process.env so the
  // daemon's bot GH_CONFIG_DIR reaches this one execFileSync bypass of git.ts.
  try {
    const stdout = execFileSync(
      ghBin,
      ["label", "list", "--repo", nwo, "--limit", "200", "--json", "name", "-q", ".[].name"],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: ghEnv ? { ...process.env, ...ghEnv } : undefined,
      },
    );
    // ... rest unchanged
```

`checkLabelsExist` opts gain `ghEnv?: Record<string, string>;` and the default fetch becomes:

```ts
const fetchFn = opts.fetchLabels ?? ((nwo: string) => _fetchRepoLabels(nwo, ghBin, opts.ghEnv));
```

`lintTicket`'s opts type gains `ghEnv?: Record<string, string>;` and its `checkLabelsExist` call passes it through alongside `ghBin`.

`src/prFlow.ts` — the `lintTicket` call at :409 adds one line to its opts:

```ts
      ghEnv: cfg.ghAuth ? ghAuthEnv(cfg.ghAuth) : undefined,
```

with `ghAuthEnv` added to the existing `./git.js` import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/planLint.test.ts tests/prFlow.test.ts > /tmp/t4.out 2>&1; echo "exit: $?"` — PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/planLint.ts src/prFlow.ts tests/planLint.test.ts
git add -A && git commit -m "feat(planLint): thread bot ghEnv into the label fetch (closes the gh bypass)"
```

---

### Task 5: Worktree commit identity (per-worktree git config)

**Files:**

- Modify: `src/worktree.ts` (prepareWorktree at :160 — both return points, :249 amend and :299 fresh)
- Test: `tests/worktree.test.ts` (real git harness — this file already builds bare-remote+clone fixtures and needs `git config user.*`, which CI sets globally)

**Interfaces:**

- Consumes: `cfg.ghAuth` (Task 1); `git()` (Task 2 — note its credential `-c` flags are injected on these local ops too; harmless).
- Produces: worktrees created under bot mode carry `user.name`/`user.email` in per-worktree config; the parent repo's identity is untouched (only the inert `extensions.worktreeConfig=true` flag is written once). No new exports — behavior only.

- [ ] **Step 1: Write the failing test**

In `tests/worktree.test.ts`, add (reuse the file's existing repo-fixture helper and its `makeConfig`-style helper — exact names are at the top of the file):

```ts
it("seeds bot identity into the worktree config, leaving the parent repo untouched", async () => {
  // <build the standard fixture the file's other prepareWorktree tests use>
  const cfg = {
    ...makeConfig(work), // the file's existing helper
    ghAuth: {
      configDir: join(work, "gh"),
      login: "junco-agent",
      email: "987654+junco-agent@users.noreply.github.com",
      credentialHelper: "!gh auth git-credential",
    },
  };
  const wt = await prepareWorktree(cfg, ctx, "task-bot-id");

  const wtName = execSync(`git -C ${wt} config user.name`, { encoding: "utf8" }).trim();
  const wtEmail = execSync(`git -C ${wt} config user.email`, { encoding: "utf8" }).trim();
  expect(wtName).toBe("junco-agent");
  expect(wtEmail).toBe("987654+junco-agent@users.noreply.github.com");

  // Parent clone identity untouched: local repo config has no user.name
  // (git config --local exits 1 when the key is absent).
  const parentLocal = spawnSync("git", ["-C", ctx.repo, "config", "--local", "user.name"], {
    encoding: "utf8",
  });
  expect(parentLocal.status).not.toBe(0);

  // A commit made inside the worktree is authored by the bot.
  writeFileSync(join(wt, "f.txt"), "x");
  execSync(`git -C ${wt} add -A && git -C ${wt} commit -m seed`, { encoding: "utf8" });
  const author = execSync(`git -C ${wt} log -1 --format=%an <%ae>`, { encoding: "utf8" }).trim();
  expect(author).toBe("junco-agent <987654+junco-agent@users.noreply.github.com>");
});

it("seeds nothing when cfg.ghAuth is absent", async () => {
  const wt = await prepareWorktree(makeConfig(work), ctx, "task-no-id");
  const r = spawnSync("git", ["-C", wt, "config", "--worktree", "user.name"], {
    encoding: "utf8",
  });
  expect(r.status).not.toBe(0);
});
```

(Note: `git -C <wt> log --format=%an` may pick up the harness's global test identity for the committer if only author is set — we set BOTH `user.name`/`user.email` per-worktree, which controls author AND committer, so `%an <%ae>` is deterministic.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worktree.test.ts > /tmp/t5.out 2>&1; echo "exit: $?"`
Expected: FAIL — worktree `git config user.name` exits non-zero / falls back to global identity.

- [ ] **Step 3: Implement**

`src/worktree.ts` — add a helper above `prepareWorktree`:

```ts
/** Bot mode: stamp the bot's identity into PER-WORKTREE git config so every
 * process committing here (the agent's bash tool — sandboxed or not — and
 * commitLeftovers) authors as the bot, while the parent clone's identity is
 * untouched. Requires extensions.worktreeConfig (git ≥ 2.20); enabling it
 * writes one inert flag into the parent's .git/config — the only mutation the
 * parent ever sees. No-op when cfg.ghAuth is absent. */
async function seedBotIdentity(cfg: Config, repoPath: string, wtPath: string): Promise<void> {
  if (!cfg.ghAuth) return;
  await git(cfg, ["config", "extensions.worktreeConfig", "true"], {
    cwd: repoPath,
    timeoutMs: 30_000,
  });
  await git(cfg, ["config", "--worktree", "user.name", cfg.ghAuth.login], {
    cwd: wtPath,
    timeoutMs: 30_000,
  });
  await git(cfg, ["config", "--worktree", "user.email", cfg.ghAuth.email], {
    cwd: wtPath,
    timeoutMs: 30_000,
  });
}
```

Insert `await seedBotIdentity(cfg, ctx.repo, wtPath);` immediately before BOTH `linkNodeModules(ctx.repo, wtPath);` lines (amend path :248 and fresh path :298).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/worktree.test.ts > /tmp/t5.out 2>&1; echo "exit: $?"` — PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/worktree.ts tests/worktree.test.ts
git add -A && git commit -m "feat(worktree): seed bot commit identity via per-worktree git config"
```

---

### Task 6: Entrypoint boundary — daemon attach + refuse-to-start, hot-reload re-attach, dispatch fork provisioning

**Files:**

- Modify: `src/cli.ts` (run-once at :372, start at :390; add injectable `withBotAuthFn` to the CLI deps interface near the other `*Fn` deps)
- Modify: `src/externalDispatch.ts` (`ExternalDispatchDeps` at :17, `resolveIssueTarget` provisioning branch at :123-126)
- Test: `tests/cli.test.ts`, `tests/externalDispatch.test.ts`

**Interfaces:**

- Consumes: `withBotAuth`, `resolveBotAuth` (Task 3); `assembleConfig` (existing); `watchConfig`'s `assembleFn` dep (existing, `src/configWatcher.ts:20`).
- Produces:
  - `start`/`run-once` operate on `await withBotAuthFn(cfg)`; a throw prints the message to stderr and returns exit 1 BEFORE lock acquisition/log setup.
  - The config watcher re-attaches the startup-resolved context on hot reload only while the reloaded file still has `botAccount.enabled` (flips are restart-kind levers — Task 1 registered them).
  - `ExternalDispatchDeps` gains `withBotAuthFn?: typeof withBotAuth`; the fork/clone provisioning call inside `resolveIssueTarget` runs under the bot context; the `gh issue view` read stays ambient.

- [ ] **Step 1: Write the failing tests**

In `tests/cli.test.ts` (the file drives `runCli` with injected deps — follow its patterns for `loadConfigFn` + fake config):

```ts
describe("bot auth at daemon entrypoints", () => {
  it("start refuses to run when bot auth resolution throws", async () => {
    const code = await runCli(["node", "cli", "start"], {
      ...baseDeps, // the file's standard dep bundle with a loadable fake config
      withBotAuthFn: async () => {
        throw new Error("botAccount.enabled is true but no working gh login exists");
      },
    });
    expect(code).toBe(1);
    // and mainLoopFn was never called (assert via the deps spy the file already uses)
  });

  it("run-once hands the attached config to runOnceFn", async () => {
    let seen: unknown;
    const code = await runCli(["node", "cli", "run-once"], {
      ...baseDeps,
      withBotAuthFn: async (c: Config) => ({ ...c, ghAuth: FAKE_CTX }),
      runOnceFn: async (c: Config) => {
        seen = c;
        return false;
      },
    });
    expect(code).toBe(0);
    expect((seen as Config).ghAuth?.login).toBe(FAKE_CTX.login);
  });
});
```

In `tests/externalDispatch.test.ts` (the file fakes `ghFn`/`ensureCloneFn`):

```ts
it("provisions unowned clones under the bot context, reads ambient", async () => {
  const cloneCfgs: Array<Config> = [];
  const deps = {
    ghFn: fakeGhIssueView, // the file's existing issue-view fake
    ensureCloneFn: async (c: Config) => {
      cloneCfgs.push(c);
      return { path: "/clones/x", forkNwo: "junco-agent/x" };
    },
    withBotAuthFn: async (c: Config) => ({ ...c, ghAuth: FAKE_CTX }),
  };
  await resolveIssueTarget(cfgWithNoWatchedRepos, "owner/x#1", deps);
  expect(cloneCfgs[0].ghAuth?.login).toBe(FAKE_CTX.login);
});
```

(`FAKE_CTX` in both files: the same literal as Task 2's `CTX`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli.test.ts tests/externalDispatch.test.ts > /tmp/t6.out 2>&1; echo "exit: $?"`
Expected: FAIL — `withBotAuthFn` is not a known dep on either interface.

- [ ] **Step 3: Implement**

`src/cli.ts`:

- Add to the CLI deps interface: `withBotAuthFn?: typeof withBotAuth;` and import `{ withBotAuth }` from `"./ghAuth.js"` (static import is fine — ghAuth has no SDK/React deps).
- In `run-once` (after `const cfg = loadConfigFn(configPath);`):

```ts
let cfgAuthed: Config;
try {
  cfgAuthed = await (deps.withBotAuthFn ?? withBotAuth)(cfg);
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  return 1;
}
```

and use `cfgAuthed` for `runOnceFn`.

- In `start` (same guard immediately after loadConfig, BEFORE the lock), then use `cfgAuthed` everywhere `cfg` was used in the branch. Wire the watcher so hot reloads keep (or drop) the context in lockstep with the file:

```ts
watcher = watchConfigFn(configPath, holder, {
  onApplied: () => gate.clearLatched(),
  // Hot reload must not silently drop (or fabricate) the bot identity:
  // re-attach the STARTUP-resolved context while the file still enables
  // it; a flip either way is a restart-kind lever (configLevers).
  assembleFn: (d) => {
    const next = assembleConfig(d);
    return next.botAccount.enabled && cfgAuthed.ghAuth
      ? { ...next, ghAuth: cfgAuthed.ghAuth }
      : next;
  },
});
```

with `assembleConfig` imported from `"./config.js"` (check the existing import line first) and `holder` seeded from `cfgAuthed`.

`src/externalDispatch.ts`:

- `ExternalDispatchDeps` gains `withBotAuthFn?: typeof withBotAuth;` (import from `"./ghAuth.js"`).
- In `resolveIssueTarget`'s unowned branch (:123), before the `ensureCloneFn` call:

```ts
// The fork this provisions is the DAEMON's future push target — it must
// live on the bot's account even though this runs human-triggered (spec:
// boundary exception). The issue-view read above stays ambient.
const botCfg = await (deps.withBotAuthFn ?? withBotAuth)(cfg);
const provisioned = await ensureCloneFn(botCfg, ref.nwo, deps, opts);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cli.test.ts tests/externalDispatch.test.ts tests/configWatcher.test.ts > /tmp/t6.out 2>&1; echo "exit: $?"` — PASS. Then the full suite — PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/cli.ts src/externalDispatch.ts
git add -A && git commit -m "feat(cli): daemon attaches bot auth (refuse-to-start on failure); dispatch forks as bot"
```

---

### Task 7: Sandbox containment — deny the bot config dir; pin scrubEnv

**Files:**

- Modify: `src/agent/sandbox/policy.ts` (buildPolicy opts + readDenyPaths at :28-49)
- Modify: `src/agent/session.ts` (buildPolicy call at :478)
- Test: `tests/sandboxPolicy.test.ts`, `tests/scrubEnv.test.ts` (create if absent — check `ls tests/ | grep -i scrub` first; the scrub assertions may belong in an existing verify/sandbox test file)

**Interfaces:**

- Consumes: `cfg.botAccount.configDir` (Task 1).
- Produces: `buildPolicy` opts gain `botGhConfigDir?: string`, appended (canonicalized) to `readDenyPaths`; session passes `cfg.botAccount.configDir` unconditionally (a token may sit there even while `enabled` is false).

- [ ] **Step 1: Write the failing tests**

In `tests/sandboxPolicy.test.ts` (synthetic non-existent paths only — canonicalize() realpaths real ones, per CLAUDE.md):

```ts
it("denies reads of the bot gh config dir when provided", () => {
  const p = buildPolicy({
    cfg: {
      enabled: true,
      backend: "none",
      network: "deny",
      extraDenyRead: [],
      extraAllowWrite: [],
    },
    cwd: "/sbxroot/wt",
    scratchDir: "/sbxroot/scratch",
    home: "/sbxroot/home",
    stateDir: "/sbxroot/state",
    network: false,
    botGhConfigDir: "/sbxroot/home/.config/junco/gh",
  });
  expect(p.readDenyPaths).toContain("/sbxroot/home/.config/junco/gh");
});
```

scrubEnv pin (in the scrub test location found in Step 1's `ls`):

```ts
it("drops GH_CONFIG_DIR and GH_TOKEN by construction", () => {
  const env = scrubEnv({ PATH: "/bin", GH_CONFIG_DIR: "/x", GH_TOKEN: "t", GITHUB_TOKEN: "t" });
  expect(env).toEqual({ PATH: "/bin" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sandboxPolicy.test.ts > /tmp/t7.out 2>&1; echo "exit: $?"`
Expected: the policy test FAILS (`botGhConfigDir` unknown / path absent). The scrubEnv pin may already PASS (allowlist) — that's fine; it's a regression pin, keep it.

- [ ] **Step 3: Implement**

`src/agent/sandbox/policy.ts` — `buildPolicy` opts gain `botGhConfigDir?: string;` and:

```ts
const readDenyPaths = [
  ...builtinDenyReadPaths(home).map(canonicalize),
  canonicalize(stateDir),
  ...(opts.botGhConfigDir ? [canonicalize(opts.botGhConfigDir)] : []),
  ...cfg.extraDenyRead.map(canonicalize),
];
```

`src/agent/session.ts` — the buildPolicy call at :478 adds:

```ts
    botGhConfigDir: cfg.botAccount.configDir,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sandboxPolicy.test.ts > /tmp/t7.out 2>&1; echo "exit: $?"` — PASS (plus the scrub pin's file).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/agent/sandbox/policy.ts src/agent/session.ts
git add -A && git commit -m "feat(sandbox): deny agent reads of the bot gh config dir; pin GH_CONFIG_DIR scrub"
```

---

### Task 8: Doctor — bot identity, same-login warning, per-repo bot permission

**Files:**

- Modify: `src/execProbe.ts` (`defaultExec` at :11 — add optional `opts?: { env? }`)
- Modify: `src/doctor.ts` (DoctorDeps execFn type at :26; new checks after the gh check at :185; watched-repo loop at :381-393)
- Test: `tests/doctor.test.ts`

**Interfaces:**

- Consumes: `cfg.botAccount` (Task 1).
- Produces:
  - `defaultExec(cmd, args, opts?: { env?: Record<string, string> })` — env merged over `process.env`. All existing callers/fakes compile (new param optional).
  - Doctor reports: `bot account` — fail when enabled+unauthed ("run: junco auth login"), warn when bot login equals ambient login, ok `acting as <login>` otherwise; per watched repo (bot mode only): `viewerPermission` under the bot env — ok on ADMIN/MAINTAIN/WRITE, warn on TRIAGE ("labels ok; branch pushes will fail — invite the bot with write"), warn on READ/NONE ("invite the bot or expect failures").

- [ ] **Step 1: Write the failing tests**

In `tests/doctor.test.ts` (the file drives `runDoctor` with an `execFn` fake and asserts printed lines — follow its pattern; the fake gains the optional third param):

```ts
it("bot mode: reports identity, flags same-login, checks repo permission as the bot", async () => {
  const execFn = async (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
    const key = args.join(" ");
    if (key === "api user" && opts?.env?.GH_CONFIG_DIR === "/sbx/junco-gh")
      return { code: 0, stdout: JSON.stringify({ login: "junco-agent", id: 1 }), stderr: "" };
    if (key === "api user")
      return { code: 0, stdout: JSON.stringify({ login: "human", id: 2 }), stderr: "" };
    if (key.startsWith("repo view") && key.includes("viewerPermission"))
      return { code: 0, stdout: JSON.stringify({ viewerPermission: "TRIAGE" }), stderr: "" };
    // ...delegate everything else to the file's existing happy-path fake
    return happyExec(cmd, args);
  };
  const out: string[] = [];
  await runDoctor(configPathWithBotEnabled, { ...happyDeps, execFn, printFn: (s) => out.push(s) });
  const text = out.join("");
  expect(text).toContain("bot account");
  expect(text).toContain("acting as junco-agent");
  expect(text).toMatch(/TRIAGE|invite the bot/);
});

it("bot mode: fails the bot-account check when not logged in", async () => {
  // api user under GH_CONFIG_DIR → code 1; expect "✗ bot account" + "junco auth login"
});
```

(Build `configPathWithBotEnabled` with the file's config-fixture helper plus `botAccount: { enabled: true, configDir: "/sbx/junco-gh" }`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/doctor.test.ts > /tmp/t8.out 2>&1; echo "exit: $?"`
Expected: FAIL — no "bot account" line printed.

- [ ] **Step 3: Implement**

`src/execProbe.ts`:

```ts
export function defaultExec(
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: 10_000, env: opts?.env ? { ...process.env, ...opts.env } : undefined },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
```

`src/doctor.ts` — widen `DoctorDeps.execFn` with the same optional third param. After the gh auth check block (:185), add:

```ts
// 4b. bot account (only when enabled): identity under the isolated config
// dir; same-login means the bot identity is doing nothing.
if (cfg.botAccount.enabled && ghVer.code === 0) {
  const botEnv = { env: { GH_CONFIG_DIR: cfg.botAccount.configDir } };
  const bot = await execFn(cfg.ghBin, ["api", "user"], botEnv);
  if (bot.code !== 0) {
    report(
      "fail",
      "bot account",
      `enabled but not logged in under ${cfg.botAccount.configDir} (run: junco auth login)`,
    );
  } else {
    let botLogin: string | null = null;
    try {
      botLogin = (JSON.parse(bot.stdout) as { login: string }).login;
    } catch {
      /* fall through to inconclusive */
    }
    if (botLogin === null) {
      report("warn", "bot account", "could not parse gh api user output");
    } else {
      const ambient = await execFn(cfg.ghBin, ["api", "user"]);
      let ambientLogin: string | null = null;
      try {
        ambientLogin =
          ambient.code === 0 ? (JSON.parse(ambient.stdout) as { login: string }).login : null;
      } catch {
        /* ambient identity is optional here */
      }
      if (ambientLogin !== null && ambientLogin === botLogin) {
        report(
          "warn",
          "bot account",
          `bot login "${botLogin}" equals your personal gh login — separate identities to get attribution/approval value`,
        );
      } else {
        report("ok", "bot account", `acting as ${botLogin}`);
      }
    }
  }
}
```

In the watched-repo loop (near :393, after the existing `gh repo view … --json name` reachability check), add (bot mode only):

```ts
if (cfg.botAccount.enabled) {
  const perm = await execFn(cfg.ghBin, ["repo", "view", repo.nwo, "--json", "viewerPermission"], {
    env: { GH_CONFIG_DIR: cfg.botAccount.configDir },
  });
  let level: string | null = null;
  try {
    level =
      perm.code === 0
        ? (JSON.parse(perm.stdout) as { viewerPermission: string }).viewerPermission
        : null;
  } catch {
    /* inconclusive */
  }
  if (level === "ADMIN" || level === "MAINTAIN" || level === "WRITE") {
    report("ok", `bot access: ${repo.nwo}`, level.toLowerCase());
  } else if (level === "TRIAGE") {
    report(
      "warn",
      `bot access: ${repo.nwo}`,
      "triage — label edits work, branch pushes will fail; invite the bot with write",
    );
  } else {
    report(
      "warn",
      `bot access: ${repo.nwo}`,
      `${level ?? "unknown"} — invite the bot as a collaborator (write) for this watched repo`,
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/doctor.test.ts tests/wizardDetect.test.ts > /tmp/t8.out 2>&1; echo "exit: $?"` — PASS (wizardDetect shares the execFn shape; it should be unaffected, verify).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/execProbe.ts src/doctor.ts
git add -A && git commit -m "feat(doctor): bot identity + per-repo bot permission checks"
```

---

### Task 9: `junco auth login` CLI subcommand

**Files:**

- Create: `src/authCmd.ts`
- Modify: `src/cli.ts` (subcommand dispatch — add before the unknown-subcommand fallthrough; USAGE at :146)
- Test: `tests/authCmd.test.ts` (create), `tests/cli.test.ts` (wiring)

**Interfaces:**

- Consumes: `runGhLogin`, `detectBotLogin`, `DEFAULT_GH_CONFIG_DIR` (Task 3); `expandHome`, `validateConfigObject` (existing, `src/config.ts`); `getAtPath`, `setAtPath` (existing, `src/configLevers.ts`).
- Produces: `export async function runAuthCommand(args: string[], configPath: string, deps?: AuthCmdDeps): Promise<number>` — `args[0] === "login"` is the only verb; anything else prints usage, returns 2.

- [ ] **Step 1: Write the failing tests**

Create `tests/authCmd.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuthCommand } from "../src/authCmd.js";

function writeConfig(dir: string, obj: unknown): string {
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

const BASE = { vaultRoot: "/tmp/v" };

describe("junco auth login", () => {
  it("logs in, flips botAccount.enabled, prints the identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    const configPath = writeConfig(dir, BASE);
    const out: string[] = [];
    const code = await runAuthCommand(["login"], configPath, {
      runGhLoginFn: async () => 0,
      detectBotLoginFn: async () => "junco-agent",
      printFn: (s) => out.push(s),
    });
    expect(code).toBe(0);
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    expect(raw.botAccount.enabled).toBe(true);
    expect(out.join("")).toContain("junco-agent");
  });

  it("fails without flipping config when gh login exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    const configPath = writeConfig(dir, BASE);
    const code = await runAuthCommand(["login"], configPath, {
      runGhLoginFn: async () => 1,
      detectBotLoginFn: async () => null,
      printFn: () => {},
    });
    expect(code).toBe(1);
    expect(JSON.parse(readFileSync(configPath, "utf8")).botAccount).toBeUndefined();
  });

  it("errors when no config exists yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    const errs: string[] = [];
    const code = await runAuthCommand(["login"], join(dir, "config.json"), {
      printErrFn: (s) => errs.push(s),
    });
    expect(code).toBe(1);
    expect(errs.join("")).toContain("junco dashboard");
  });

  it("prints usage on unknown verb", async () => {
    const code = await runAuthCommand(["logout"], "/nonexistent", { printErrFn: () => {} });
    expect(code).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/authCmd.test.ts > /tmp/t9.out 2>&1; echo "exit: $?"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/authCmd.ts`:

```ts
/**
 * `junco auth login` — the headless/re-auth vehicle for the bot account
 * (spec 2026-07-15): run gh's interactive device-flow login into the isolated
 * GH_CONFIG_DIR, verify the identity, flip botAccount.enabled in config.json
 * (atomic temp+rename, the wizard/configCmd pattern). The wizard's Account
 * chapter shares the same runGhLogin/detectBotLogin routines (src/ghAuth.ts).
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandHome, validateConfigObject } from "./config.js";
import { getAtPath, setAtPath } from "./configLevers.js";
import { DEFAULT_GH_CONFIG_DIR, detectBotLogin, runGhLogin } from "./ghAuth.js";

export interface AuthCmdDeps {
  runGhLoginFn?: typeof runGhLogin;
  detectBotLoginFn?: typeof detectBotLogin;
  printFn?: (s: string) => void;
  printErrFn?: (s: string) => void;
  existsFn?: (p: string) => boolean;
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, c: string) => void;
  renameFn?: (from: string, to: string) => void;
  unlinkFn?: (p: string) => void;
}

const USAGE = "Usage: junco auth login   (log the bot account in; see docs/bot-account.md)\n";

export async function runAuthCommand(
  args: string[],
  configPath: string,
  deps: AuthCmdDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const printErr = deps.printErrFn ?? ((s: string) => process.stderr.write(s));
  if (args[0] !== "login") {
    printErr(USAGE);
    return 2;
  }
  const resolved = resolve(configPath);
  const existsFn = deps.existsFn ?? existsSync;
  if (!existsFn(resolved)) {
    printErr(
      `no config at ${resolved} — run \`junco dashboard\` (guided setup) or \`junco config init\` first\n`,
    );
    return 1;
  }
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileFn(resolved)) as Record<string, unknown>;
  } catch (e) {
    printErr(`config unreadable: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const configDir = expandHome(
    (getAtPath(raw, "botAccount.configDir") as string | undefined) ?? DEFAULT_GH_CONFIG_DIR,
  );
  const ghBin = (getAtPath(raw, "git.ghBin") as string | undefined) ?? "gh";

  print(`Logging the bot account in (isolated gh config dir: ${configDir})…\n`);
  const code = await (deps.runGhLoginFn ?? runGhLogin)(ghBin, configDir);
  if (code !== 0) {
    printErr(`gh auth login exited ${code} — config untouched\n`);
    return 1;
  }
  const login = await (deps.detectBotLoginFn ?? detectBotLogin)(ghBin, configDir);
  if (login === null) {
    printErr("login finished but the identity could not be resolved — config untouched\n");
    return 1;
  }

  setAtPath(raw, "botAccount.enabled", true);
  validateConfigObject(raw);
  // Atomic temp+rename (wizard/configCmd pattern) — never truncate in place.
  const tmp = join(dirname(resolved), `.config.json.tmp-${process.pid}`);
  const writeFileFn = deps.writeFileFn ?? ((p: string, c: string) => writeFileSync(p, c, "utf8"));
  const renameFn = deps.renameFn ?? renameSync;
  const unlinkFn = deps.unlinkFn ?? unlinkSync;
  writeFileFn(tmp, JSON.stringify(raw, null, 2) + "\n");
  try {
    renameFn(tmp, resolved);
  } catch (e) {
    try {
      unlinkFn(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }

  print(`✓ junco now acts as ${login} for daemon GitHub traffic (botAccount.enabled=true)\n`);
  print(`  Restart the daemon to apply: junco restart\n`);
  return 0;
}
```

`src/cli.ts` — before the unknown-subcommand block:

```ts
// ------------------------------------------------------------
// auth login: log the bot account in (isolated GH_CONFIG_DIR). Lazy import
// keeps it off every other subcommand's require graph.
// ------------------------------------------------------------
if (subcommand === "auth") {
  const { runAuthCommand } = await import("./authCmd.js");
  return runAuthCommand(positionals.slice(1), configPath, {});
}
```

USAGE gains one line after `doctor`:

```
  auth login   Log the junco bot account in (isolated gh config dir; daemon acts as it)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/authCmd.test.ts tests/cli.test.ts > /tmp/t9.out 2>&1; echo "exit: $?"` — PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/authCmd.ts src/cli.ts tests/authCmd.test.ts
git add -A && git commit -m "feat(cli): junco auth login — bot-account device-flow login + config flip"
```

---

### Task 10: Wizard plumbing — answers, chapter list, detect probe, WizardIO

**Files:**

- Modify: `src/wizard/flow.ts` (WizardAnswers :19, CHAPTERS :32, defaultAnswers :45, buildConfigObject :60, coveredPaths :109, answersFromConfig :160)
- Modify: `src/wizard/detect.ts` (DetectDeps execFn type :24; new `botLoginCheck`)
- Modify: `src/wizard/io.ts` (WizardIO interface)
- Modify: `src/wizard.ts` (buildWizardIO wiring + WizardDeps)
- Modify: `src/wizard/tips.ts` (new TipKey + copy)
- Test: `tests/wizardFlow.test.ts`, `tests/wizardDetect.test.ts`, `tests/wizard.test.ts`

**Interfaces:**

- Consumes: `detectBotLogin`, `runGhLogin`, `DEFAULT_GH_CONFIG_DIR` (Task 3).
- Produces:
  - `WizardAnswers` gains `botAccount: boolean` (enabled only — configDir stays the schema default; YAGNI).
  - `CHAPTERS` becomes `["Welcome","Workspace","Model","Repo safety","GitHub","Account","Extras","Review"]`.
  - `buildConfigObject`: `if (a.botAccount) obj.botAccount = { enabled: true };`
  - `coveredPaths` adds `{ path: "botAccount.enabled", value: a.botAccount }` (COVERED_LEVER_COUNT derives).
  - `answersFromConfig`: `botAccount: (g("botAccount.enabled") as boolean) ?? false`.
  - `detect.ts`: `DetectDeps.execFn` gains optional `opts?: { env?: Record<string, string> }` third param; `export async function botLoginCheck(ghBin: string, configDir: string, deps?: DetectDeps): Promise<{ check: CheckResult; login: string | null }>`.
  - `WizardIO` gains: `botGhConfigDir: string; detectBotLogin(): Promise<string | null>; runGhLogin(): Promise<number>;` — `buildWizardIO` wires defaults from `ghAuth.ts` (rerun mode reads `botAccount.configDir`/`git.ghBin` from the raw config; fresh mode uses defaults); `WizardDeps` gains `detectBotLoginFn?`/`runGhLoginFn?` fakes.
  - tips: `TIPS.account` — copy: `"A dedicated bot account keeps junco's PRs, comments, and labels attributed to the bot — and since the bot can never approve its own work, your approval labels stay meaningful. Your personal gh login stays untouched for everything you run by hand."`

- [ ] **Step 1: Write the failing tests**

`tests/wizardFlow.test.ts` additions:

```ts
it("botAccount answer round-trips: build, prefill, diff", () => {
  const a = { ...defaultAnswers(), botAccount: true };
  const obj = buildConfigObject(a);
  expect(obj.botAccount).toEqual({ enabled: true });
  // fresh default omits the block entirely
  expect(buildConfigObject(defaultAnswers()).botAccount).toBeUndefined();
  // prefill
  expect(answersFromConfig({ vaultRoot: "/v", botAccount: { enabled: true } }).botAccount).toBe(
    true,
  );
  expect(answersFromConfig({ vaultRoot: "/v" }).botAccount).toBe(false);
  // rerun diff: flipping it registers exactly one change at the lever path
  const diffs = diffAnswers(
    { vaultRoot: "/v" },
    { ...answersFromConfig({ vaultRoot: "/v" }), botAccount: true },
  );
  expect(diffs).toEqual([{ path: "botAccount.enabled", from: undefined, to: true }]);
});

it("CHAPTERS includes Account between GitHub and Extras", () => {
  expect(CHAPTERS.indexOf("Account")).toBe(CHAPTERS.indexOf("GitHub") + 1);
  expect(CHAPTERS.indexOf("Extras")).toBe(CHAPTERS.indexOf("Account") + 1);
});
```

(If the file pins `COVERED_LEVER_COUNT` or renders expected config JSON strings, update those pins.)

`tests/wizardDetect.test.ts` additions:

```ts
it("botLoginCheck: ok with login when authed under the config dir", async () => {
  const execFn = async (_c: string, args: string[], opts?: { env?: Record<string, string> }) => {
    expect(opts?.env?.GH_CONFIG_DIR).toBe("/sbx/junco-gh");
    return { code: 0, stdout: JSON.stringify({ login: "junco-agent", id: 1 }), stderr: "" };
  };
  const r = await botLoginCheck("gh", "/sbx/junco-gh", { execFn });
  expect(r.login).toBe("junco-agent");
  expect(r.check.verdict).toBe("ok");
});

it("botLoginCheck: warn with null login when unauthenticated", async () => {
  const execFn = async () => ({ code: 1, stdout: "", stderr: "" });
  const r = await botLoginCheck("gh", "/sbx/junco-gh", { execFn });
  expect(r.login).toBeNull();
  expect(r.check.verdict).toBe("warn");
});
```

`tests/wizard.test.ts` additions: `buildWizardIO` result exposes `botGhConfigDir` (expanded default in fresh mode; the raw config's value in rerun mode) and `detectBotLogin`/`runGhLogin` are wired to the injected fakes.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/wizardFlow.test.ts tests/wizardDetect.test.ts tests/wizard.test.ts > /tmp/t10.out 2>&1; echo "exit: $?"`
Expected: FAIL across all three.

- [ ] **Step 3: Implement**

`src/wizard/flow.ts` — apply the five Produces bullets verbatim: add `botAccount: boolean;` to `WizardAnswers`; `"Account"` after `"GitHub"` in `CHAPTERS`; `botAccount: false` in `defaultAnswers()`; in `buildConfigObject` after the github block: `if (a.botAccount) obj.botAccount = { enabled: true };`; in `coveredPaths` return array after the github entries: `{ path: "botAccount.enabled", value: a.botAccount },`; in `answersFromConfig`: `botAccount: (g("botAccount.enabled") as boolean) ?? false,`.

`src/wizard/detect.ts` — widen `DetectDeps.execFn`:

```ts
  execFn?: (
    cmd: string,
    args: string[],
    opts?: { env?: Record<string, string> },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
```

and add:

```ts
/** Account-chapter probe: is a bot login present under the isolated config
 * dir? warn (not fail) when absent — the chapter offers the login step next. */
export async function botLoginCheck(
  ghBin: string,
  configDir: string,
  deps: DetectDeps = {},
): Promise<{ check: CheckResult; login: string | null }> {
  const execFn = deps.execFn ?? defaultExec;
  const r = await execFn(ghBin, ["api", "user"], { env: { GH_CONFIG_DIR: configDir } });
  if (r.code !== 0) {
    return {
      check: { verdict: "warn", label: "bot account", detail: "not logged in yet" },
      login: null,
    };
  }
  try {
    const login = (JSON.parse(r.stdout) as { login: string }).login;
    return { check: { verdict: "ok", label: "bot account", detail: `acting as ${login}` }, login };
  } catch {
    return {
      check: { verdict: "warn", label: "bot account", detail: "could not parse identity" },
      login: null,
    };
  }
}
```

(`defaultExec` already accepts the optional opts after Task 8.)

`src/wizard/io.ts` — `WizardIO` gains:

```ts
  /** Isolated gh config dir the Account chapter logs the bot into. */
  botGhConfigDir: string;
  /** Bot login under botGhConfigDir, or null. Never throws. */
  detectBotLogin(): Promise<string | null>;
  /** Interactive gh device-flow login (caller suspends Ink around it). */
  runGhLogin(): Promise<number>;
```

`src/wizard.ts` — `WizardDeps` gains `detectBotLoginFn?: typeof detectBotLogin; runGhLoginFn?: typeof runGhLogin;` (type-only import from `./ghAuth.js` is NOT enough — import the values for defaults). In `buildWizardIO`, before the `io` literal:

```ts
const rawBotDir =
  raw !== null ? (getAtPath(raw, "botAccount.configDir") as string | undefined) : undefined;
const rawGhBin = raw !== null ? (getAtPath(raw, "git.ghBin") as string | undefined) : undefined;
const botGhConfigDir = expandHome(rawBotDir ?? DEFAULT_GH_CONFIG_DIR);
const wizGhBin = rawGhBin ?? "gh";
```

(`getAtPath` from `./configLevers.js`.) And in the `io` literal:

```ts
    botGhConfigDir,
    detectBotLogin: () => (deps.detectBotLoginFn ?? detectBotLogin)(wizGhBin, botGhConfigDir),
    runGhLogin: () => (deps.runGhLoginFn ?? runGhLogin)(wizGhBin, botGhConfigDir),
```

`src/wizard/tips.ts` — add `account` to the `TipKey` union and `TIPS`:

```ts
  account:
    "A dedicated bot account keeps junco's PRs, comments, and labels attributed to the bot — and since the bot can never approve its own work, your approval labels stay meaningful. Your personal gh login stays untouched for everything you run by hand.",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/wizardFlow.test.ts tests/wizardDetect.test.ts tests/wizard.test.ts tests/wizardTips.test.ts > /tmp/t10.out 2>&1; echo "exit: $?"` — PASS (wizardTips may pin the tip-key set; update it).
NOTE: `tests/wizardApp.test.tsx` / `tests/wizardChapters.test.tsx` will now FAIL on the chapter count/router until Task 11 — if so, do Tasks 10+11 as one commit-pair without an intermediate full-suite gate, or stub the router entry first. Prefer: finish Task 11 before running the full suite.

- [ ] **Step 5: Commit** (only if the full suite is green; otherwise fold into Task 11's commit)

```bash
npx prettier --write src/wizard/flow.ts src/wizard/detect.ts src/wizard/io.ts src/wizard.ts src/wizard/tips.ts
git add -A && git commit -m "feat(wizard): botAccount answer, Account chapter slot, bot-login probe + IO"
```

---

### Task 11: Account chapter UI + Ink suspend + WizardApp router

**Files:**

- Create: `src/tui/wizard/chapters/Account.tsx`
- Create: `src/tui/useSuspend.ts`
- Modify: `src/tui/wizard/WizardApp.tsx` (import + router at :91-109)
- Test: `tests/wizardChapters.test.tsx` (chapter behavior), `tests/wizardApp.test.tsx` (rail/router pins)

**Interfaces:**

- Consumes: `ChapterProps` (`src/tui/wizard/controls.tsx:17`), `Select`/`Tip` (same file), `io.detectBotLogin`/`io.runGhLogin`/`io.botGhConfigDir` (Task 10), `MOUSE_ENABLE`/`MOUSE_DISABLE` (`src/tui/mouse.js`), `useStdin`/`useStdout` (ink).
- Produces: `export function Account(props: ChapterProps): React.JSX.Element`; `export function useSuspend(): <T>(fn: () => Promise<T>) => Promise<T>`.

- [ ] **Step 1: Write the failing tests**

In `tests/wizardChapters.test.tsx` (follow the file's ink-testing-library conventions — fake `io`, `patch` spy, loop-until-condition waits per CLAUDE.md, never one fixed tick):

```tsx
describe("Account chapter", () => {
  it("default choice keeps ambient identity and advances", async () => {
    // render <Account {...props} io={fakeIo} />; press Enter on the first
    // option ("Your gh login"); expect patch({ botAccount: false }) and onNext.
  });

  it("bot choice with an existing login shows ✓ acting as <login>", async () => {
    // fakeIo.detectBotLogin resolves "junco-agent"; choose the bot option;
    // await until lastFrame() contains "acting as junco-agent"; Enter → onNext
    // and patch({ botAccount: true }).
  });

  it("bot choice without a login offers Log in now / Skip", async () => {
    // detectBotLogin → null; expect the login Select; choosing Skip patches
    // botAccount: true and advances (doctor nags later).
  });

  it("Log in now runs io.runGhLogin then re-detects", async () => {
    // runGhLogin resolves 0 and flips the detect fake to "junco-agent";
    // await until frame shows "acting as junco-agent".
  });
});
```

In `tests/wizardApp.test.tsx`: update any chapter-rail pins (the rail now shows 8 chapters; Account renders at idx 5).

Unit test for the hook (same file or `tests/wizardChapters.test.tsx`): rendering a probe component that calls `useSuspend` with a fake non-TTY stdout writes NO escape sequences and still runs the wrapped fn (assert its resolved value).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/wizardChapters.test.tsx tests/wizardApp.test.tsx > /tmp/t11.out 2>&1; echo "exit: $?"`
Expected: FAIL — Account not exported / router mismatch.

- [ ] **Step 3: Implement**

Create `src/tui/useSuspend.ts`:

```ts
/** Suspend the Ink session around an interactive child process (gh's
 * device-flow login): drop raw mode, pause stdin, disable mouse reporting,
 * and leave the alt screen so the child owns the real terminal; restore
 * everything afterwards. TTY-gated like MouseProvider — under
 * ink-testing-library's fake streams this only toggles raw mode. */
import { useStdin, useStdout } from "ink";
import { MOUSE_DISABLE, MOUSE_ENABLE } from "./mouse.js";

const ALT_SCREEN_LEAVE = "\x1b[?1049l";
const ALT_SCREEN_ENTER = "\x1b[?1049h";

export function useSuspend(): <T>(fn: () => Promise<T>) => Promise<T> {
  const { stdin, setRawMode } = useStdin();
  const { stdout } = useStdout();
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const isTTY = Boolean(stdout.isTTY);
    if (isTTY) stdout.write(MOUSE_DISABLE + ALT_SCREEN_LEAVE);
    setRawMode(false);
    stdin.pause();
    try {
      return await fn();
    } finally {
      stdin.resume();
      setRawMode(true);
      if (isTTY) stdout.write(ALT_SCREEN_ENTER + MOUSE_ENABLE);
    }
  };
}
```

Create `src/tui/wizard/chapters/Account.tsx`:

```tsx
/** Chapter 5 — who junco acts as on GitHub. Default keeps the ambient gh
 * login (zero gh calls). Choosing the bot probes the isolated config dir and,
 * when no login exists, offers gh's device-flow login (Ink suspended around
 * it) or a skip (junco auth login later; doctor nags until then). */
import React, { useState } from "react";
import { Box, Text } from "ink";
import { Tip, Select, type ChapterProps } from "../controls.js";
import { TIPS } from "../../../wizard/tips.js";
import { theme } from "../../theme.js";
import { useSuspend } from "../../useSuspend.js";

type Step = "toggle" | "checking" | "found" | "login" | "running";

export function Account({ answers, patch, onNext, io }: ChapterProps): React.JSX.Element {
  const [step, setStep] = useState<Step>("toggle");
  const [login, setLogin] = useState<string | null>(null);
  const suspend = useSuspend();

  const detect = async (): Promise<void> => {
    setStep("checking");
    const l = await io.detectBotLogin();
    if (l !== null) {
      setLogin(l);
      patch({ botAccount: true });
      setStep("found");
    } else {
      setStep("login");
    }
  };

  return (
    <Box flexDirection="column">
      {step === "toggle" && (
        <>
          <Text>Who should junco act as on GitHub?</Text>
          <Box marginTop={1}>
            <Select
              focus
              initial={answers.botAccount ? 1 : 0}
              options={[
                { value: "ambient", label: "Your gh login", hint: "default — nothing changes" },
                { value: "bot", label: "A dedicated bot account", hint: "daemon acts as the bot" },
              ]}
              onSubmit={(v) => {
                if (v === "ambient") {
                  patch({ botAccount: false });
                  onNext();
                } else {
                  void detect();
                }
              }}
            />
          </Box>
          <Tip>{TIPS.account}</Tip>
        </>
      )}
      {step === "checking" && <Text dimColor>checking {io.botGhConfigDir}…</Text>}
      {step === "found" && (
        <>
          <Text>
            <Text color={theme.success}>✓</Text> bot account —{" "}
            <Text color={theme.accent}>acting as {login}</Text>
          </Text>
          <Box marginTop={1}>
            <Select
              focus
              options={[{ value: "next", label: "Continue" }]}
              onSubmit={() => onNext()}
            />
          </Box>
        </>
      )}
      {step === "login" && (
        <>
          <Text>No bot login yet under {io.botGhConfigDir}.</Text>
          <Text dimColor>
            Create the machine account on github.com first (a normal account, e.g. junco-agent).
          </Text>
          <Box marginTop={1}>
            <Select
              focus
              options={[
                {
                  value: "login",
                  label: "Log in now",
                  hint: "opens your browser (gh device flow)",
                },
                { value: "skip", label: "Skip — I'll run `junco auth login` later" },
              ]}
              onSubmit={(v) => {
                if (v === "skip") {
                  patch({ botAccount: true }); // doctor nags until the login exists
                  onNext();
                } else {
                  setStep("running");
                  void suspend(() => io.runGhLogin()).then(() => detect());
                }
              }}
            />
          </Box>
        </>
      )}
      {step === "running" && <Text dimColor>gh auth login running in your terminal…</Text>}
    </Box>
  );
}
```

`src/tui/wizard/WizardApp.tsx` — add `import { Account } from "./chapters/Account.js";` and update the router (GitHub stays idx 4):

```tsx
    ) : idx === 4 ? (
      <Github {...chapterProps} />
    ) : idx === 5 ? (
      <Account {...chapterProps} />
    ) : idx === 6 ? (
      <Extras {...chapterProps} />
    ) : (
      <Review {...chapterProps} onWrite={write} onCancel={cancel} />
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/wizardChapters.test.tsx tests/wizardApp.test.tsx > /tmp/t11.out 2>&1; echo "exit: $?"` — PASS.
Then the FULL suite (Tasks 10+11 together must leave it green): `npx vitest run > /tmp/full11.out 2>&1; echo "exit: $?"` — PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/wizard/chapters/Account.tsx src/tui/useSuspend.ts src/tui/wizard/WizardApp.tsx
git add -A && git commit -m "feat(wizard): Account chapter — bot login via suspended gh device flow"
```

---

### Task 12: Docs + full gate

**Files:**

- Create: `docs/bot-account.md`
- Modify: `docs/github-mode.md` (:60 — "Auth is whatever `gh auth login` already holds; there are no new secrets." is no longer the whole truth)
- Modify: `ARCHITECTURE.md` (module map: `ghAuth.ts`, `authCmd.ts`; one paragraph on the auth seam)
- Modify: `README.md` (feature bullet + `junco auth login` in the command table if one exists)
- Modify: `CHANGELOG.md` (Unreleased → Added)

**Interfaces:** none — prose. Content requirements:

- [ ] **Step 1: Write `docs/bot-account.md`** covering, in this order: why (attribution, approval separation, non-owned-repo forks); setup (create machine account → `junco auth login` or the wizard Account chapter → invite the bot with write on watched repos); how it works (isolated `GH_CONFIG_DIR`, daemon-only boundary, fork provisioning exception, per-worktree commit identity, refuse-to-start posture); doctor checks; **migration notes verbatim from the spec**: historical `@me` dedup mismatch (one-time duplicate plan-comments/findings possible), stale personal-fork remotes fail loud on push (remove the `fork` remote, re-provision), same-login warning. Stack-agnostic copy throughout.

- [ ] **Step 2: Update the other four docs.** `github-mode.md`: replace the "no new secrets" sentence with a pointer — auth is ambient by default; with `botAccount.enabled` the daemon acts as the bot (see `docs/bot-account.md`). `ARCHITECTURE.md`: add `ghAuth.ts` + `authCmd.ts` to the module map; note the `git.ts` env seam. `README.md`: one feature bullet + command-table row. `CHANGELOG.md` under Unreleased/Added: "Dedicated bot-account identity for daemon GitHub traffic (`junco auth login`, wizard Account chapter, `botAccount` config block)".

- [ ] **Step 3: Full gate**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test > /tmp/gate.out 2>&1; echo "exit: $?"`
Expected: exit 0. Fix anything it surfaces (lint on new files, prettier drift, the packaged-CLI smoke test is CI-only).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: bot-account guide; auth-seam notes in architecture/readme/changelog"
```

---

## Self-Review (done at plan-write time)

1. **Spec coverage:** decisions 1-5 → Tasks 3/6 (identity+boundary), 3 (credential storage), 5 (commit authorship), 6 (fork provisioning); architecture sections: ghAuth → T3, config → T1, seam+planLint → T2/T4, boundary → T6, commit identity → T5, provisioning UX → T9/T10/T11, doctor+failure posture → T6/T8, sandbox → T7, migration+docs → T12, testing → embedded per task. Gap check: `run-once` refuse-to-start covered (T6); watcher re-attach covered (T6).
2. **Placeholder scan:** test skeletons in T6/T11 reference the target file's existing helpers by intent (`baseDeps`, `happyExec`, fixture builders) because those names live in files the implementer opens first — each such reference says exactly which file and what to reuse. No TBDs.
3. **Type consistency:** `GhAuthContext { configDir, login, email, credentialHelper }` used identically in T1/T2/T3/T5/T6; `execFn(cmd, args, opts?: { env? })` shape identical in T3/T8/T10; `withBotAuthFn` dep name identical in T6 (cli + externalDispatch); `botGhConfigDir` name identical in T7 (policy) and T10/T11 (wizard io).
