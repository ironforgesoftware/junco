# Agent Execution Sandbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confine the Pi agent's tool execution to its worktree with no ambient credentials and no network by default, using native OS sandboxing (Seatbelt on macOS, bubblewrap on Linux), gated behind config and failing closed.

**Architecture:** All new behavior hangs off one chokepoint — `makePiSessionFactory` in `src/agent/session.ts` — so every flow (PR, Q&A, assess, analyze, critic) inherits it with zero call-site churn. Security logic lives in **pure, SDK-free modules** under `src/agent/sandbox/` (backend argv generation, filesystem policy, path-jail, env scrub) that are exhaustively unit-tested. A thin glue layer builds Pi `customTools` whose `operations` route bash through the OS sandbox (argv arrays — no shell quoting) and route `read/write/edit/ls/find/grep` through a JS path-jail. The SDK is touched only inside the factory's existing `await import(...)` closure, honoring the repo's hard rule. Everything is inert unless `[sandbox].enabled` is true.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), vitest, zod, `@earendil-works/pi-coding-agent` 0.80.3, macOS `sandbox-exec` (Seatbelt SBPL), Linux `bwrap` (bubblewrap).

## Global Constraints

- **Node ≥ 22.19.0**; ESM/NodeNext; `node:`-prefixed builtins; `.js` extensions on first-party imports; TS strict.
- **Never import the Pi SDK at module top level in `src/`** (type-only is fine, but this plan avoids even that by using local structural types). The only runtime `await import("@earendil-works/pi-coding-agent"...)` stays inside `makePiSessionFactory`.
- **`src/ticketSchema.ts` is a stable public contract — additive changes only.** The new `network:` frontmatter defaults to `false` and only ever *widens* one ticket; never widen a default.
- **Every side effect goes behind an injectable `deps` seam** (spawn, exec-probe, clock). Tests never touch the network or a real model.
- Dependencies are **exact-pinned**; this plan adds **no new npm dependency**.
- **Adding a `Config` field breaks all six full-`Config` test fixtures** (`tests/{runOnce,prFlow,orphans,repo,worktree,daemon}.test.ts`). Every one must be updated in the same task. `npm run typecheck` (via `tsconfig.eslint.json`) catches misses; vitest does not type-check.
- **No AI attribution in commits** (no `Co-Authored-By: Claude`, no "Generated with" lines). If a subagent adds one, amend it away.
- **Exit-code trap:** never pipe vitest into `grep`/`tail`. Capture: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"`.
- **Full gate before "done":** `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`.
- **This repo doubles as the maintainer's live runtime.** `[sandbox].enabled` defaults to **`false`** in code (Task 14 documents how the maintainer opts in) so merging never disrupts the running daemon.

---

## File Structure

**New (all pure / SDK-free unless noted):**
- `src/scrubEnv.ts` — `ENV_ALLOWLIST` + `scrubEnv(source)`, extracted from `verify.ts`. Shared by verification blocks and agent bash.
- `src/agent/sandbox/policy.ts` — `SandboxPolicy` type, `builtinDenyReadPaths(home)`, `buildPolicy(...)`.
- `src/agent/sandbox/pathJail.ts` — `resolveWithin`, `isUnderAnyRoot`, `assertWriteAllowed`, `assertReadAllowed`, `SandboxViolation`.
- `src/agent/sandbox/backend.ts` — `SandboxBackend` interface, `seatbeltProfile`, `bwrapArgs`, `seatbeltBackend`, `bwrapBackend`, `noneBackend`, `selectBackend`, `defaultExecProbe`.
- `src/agent/sandbox/bashOps.ts` — `makeSandboxedBashOperations(backend, policy, deps?)` → `BashOperationsLike` (own argv spawn, scrubbed env).
- `src/agent/sandbox/fsOps.ts` — `makeJailed{Read,Write,Edit,Ls,Find,Grep}Operations(cwd, policy)`.
- `src/agent/sandbox/index.ts` — `buildSandbox(factories, opts)` glue + `SandboxUnavailableError` + `toolsOptionsFor`.
- `tests/scrubEnv.test.ts`, `tests/sandboxPolicy.test.ts`, `tests/sandboxPathJail.test.ts`, `tests/sandboxBackend.test.ts`, `tests/sandboxBashOps.test.ts`, `tests/sandboxFsOps.test.ts`, `tests/sandboxBuild.test.ts`, `tests/sandbox.integration.test.ts`.

**Modified:**
- `src/verify.ts` — `verificationEnv` delegates to `scrubEnv`.
- `src/types.ts` — `SandboxConfig` interface + `sandbox` field on `Config`.
- `src/config.ts` — `[sandbox]` zod section + `loadConfig` mapping.
- `src/ticketSchema.ts`, `src/ticket.ts`, `src/types.ts` (Ticket) — `network?: boolean` frontmatter.
- `src/agent/session.ts` — wire `buildSandbox` into `makePiSessionFactory`; extend `SessionOverrides` with `network?`.
- `src/prFlow.ts` — pass `{ network: task.network }` at both factory call sites.
- `src/planPrompt.ts`, `src/externalDispatch.ts` — note `network` is machine-owned for bridged tickets.
- `src/doctor.ts` — sandbox backend preflight check.
- `tests/{runOnce,prFlow,orphans,repo,worktree,daemon}.test.ts` — add `sandbox:` to each `Config` fixture.
- `CHANGELOG.md`, `docs/configuration.md`, `docs/operations.md`, `ARCHITECTURE.md` — document the feature + dedicated-identity guidance.

---

## Task 1: Extract shared env scrub (`scrubEnv`)

**Files:**
- Create: `src/scrubEnv.ts`
- Create: `tests/scrubEnv.test.ts`
- Modify: `src/verify.ts` (lines 46–72 region)

**Interfaces:**
- Produces: `export const ENV_ALLOWLIST: Set<string>`; `export function scrubEnv(source?: Record<string, string | undefined>): Record<string, string>`
- Consumers: `verify.ts` (`verificationEnv`), later `bashOps.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/scrubEnv.test.ts
import { describe, it, expect } from "vitest";
import { scrubEnv, ENV_ALLOWLIST } from "../src/scrubEnv.js";

describe("scrubEnv", () => {
  it("keeps allowlisted vars and every LC_* var", () => {
    const out = scrubEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
    });
    expect(out).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/x",
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
    });
  });

  it("drops secret-shaped vars by construction", () => {
    const out = scrubEnv({
      PATH: "/usr/bin",
      GH_TOKEN: "ghp_secret",
      GITHUB_TOKEN: "x",
      OPENAI_API_KEY: "sk-x",
    });
    expect(out.GH_TOKEN).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  it("skips undefined values", () => {
    const out = scrubEnv({ PATH: undefined, HOME: "/h" });
    expect("PATH" in out).toBe(false);
    expect(out.HOME).toBe("/h");
  });

  it("exposes the allowlist as a Set for inspection", () => {
    expect(ENV_ALLOWLIST.has("PATH")).toBe(true);
    expect(ENV_ALLOWLIST.has("GH_TOKEN")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scrubEnv.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -20 /tmp/o`
Expected: FAIL — cannot resolve `../src/scrubEnv.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/scrubEnv.ts

/**
 * Minimal env allowlist for untrusted child processes (verification blocks and
 * the sandboxed agent bash tool): shell/locale/tmp basics plus PATH+HOME (git
 * resolves binaries and ~/.gitconfig through them). Everything else — GH_TOKEN,
 * GITHUB_TOKEN, API-key-shaped vars — is dropped by construction because this
 * is an allowlist, not a denylist. (Extracted from verify.ts, #35.)
 */
export const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TMPDIR",
  "TERM",
  "TZ",
]);

/** Build the scrubbed child env: allowlisted names + every LC_* locale var. */
export function scrubEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && (ENV_ALLOWLIST.has(k) || k.startsWith("LC_"))) env[k] = v;
  }
  return env;
}
```

- [ ] **Step 4: Refactor `verify.ts` to delegate (keep behavior identical)**

In `src/verify.ts`, delete the local `ENV_ALLOWLIST` const (lines ~46–61) and replace the `verificationEnv` body (lines ~63–72) so it delegates. Add the import near the other first-party imports at the top:

```ts
import { scrubEnv } from "./scrubEnv.js";
```

Replace the `verificationEnv` function with:

```ts
/** Build the scrubbed child env for verification blocks (see scrubEnv, #35). */
export function verificationEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return scrubEnv(source);
}
```

- [ ] **Step 5: Run tests to verify pass (new + existing verify suite)**

Run: `npx vitest run tests/scrubEnv.test.ts tests/verify.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -15 /tmp/o`
Expected: PASS for both files (verify's existing env-scrub assertions still pass through the delegation).

- [ ] **Step 6: Commit**

```bash
git add src/scrubEnv.ts tests/scrubEnv.test.ts src/verify.ts
git commit -m "refactor(agent): extract shared scrubEnv from verify env allowlist"
```

---

## Task 2: `[sandbox]` config section + `Config` field + fixtures

**Files:**
- Modify: `src/types.ts` (add `SandboxConfig`, add `sandbox` to `Config`)
- Modify: `src/config.ts` (zod section ~after the `verify` block; `loadConfig` mapping)
- Create: `tests/sandboxConfig.test.ts`
- Modify: `tests/runOnce.test.ts`, `tests/prFlow.test.ts`, `tests/orphans.test.ts`, `tests/repo.test.ts`, `tests/worktree.test.ts`, `tests/daemon.test.ts`

**Interfaces:**
- Produces: `SandboxConfig { enabled: boolean; backend: "auto"|"seatbelt"|"bwrap"|"none"; network: "deny"|"allow"; extraDenyRead: string[]; extraAllowWrite: string[] }`; `Config.sandbox: SandboxConfig`.
- Consumed by: policy/session tasks.

- [ ] **Step 1: Write the failing test**

```ts
// tests/sandboxConfig.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

const dirs: string[] = [];
function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "junco-sbxcfg-"));
  dirs.push(dir);
  const p = join(dir, "config.toml");
  writeFileSync(p, body);
  return p;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE = `vault_root = "~/vault"\n[model]\nid = "x/y"\nbase_url = "http://127.0.0.1:1/v1"\napi_key = "k"\n`;

describe("[sandbox] config", () => {
  it("defaults: disabled, auto backend, network deny, empty lists", () => {
    const cfg = loadConfig(writeConfig(BASE));
    expect(cfg.sandbox).toEqual({
      enabled: false,
      backend: "auto",
      network: "deny",
      extraDenyRead: [],
      extraAllowWrite: [],
    });
  });

  it("parses an explicit section and expands ~ in path lists", () => {
    const cfg = loadConfig(
      writeConfig(
        BASE +
          `[sandbox]\nenabled = true\nbackend = "bwrap"\nnetwork = "allow"\nextra_deny_read = ["~/secrets"]\nextra_allow_write = ["~/scratch"]\n`,
      ),
    );
    expect(cfg.sandbox.enabled).toBe(true);
    expect(cfg.sandbox.backend).toBe("bwrap");
    expect(cfg.sandbox.network).toBe("allow");
    expect(cfg.sandbox.extraDenyRead[0].startsWith("~")).toBe(false);
    expect(cfg.sandbox.extraAllowWrite[0].endsWith("/scratch")).toBe(true);
  });

  it("rejects an unknown backend", () => {
    expect(() => loadConfig(writeConfig(BASE + `[sandbox]\nbackend = "docker"\n`))).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sandboxConfig.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -20 /tmp/o`
Expected: FAIL — `cfg.sandbox` is undefined.

- [ ] **Step 3: Add the type to `src/types.ts`**

Add this interface near `AssessConfig` (after line ~58):

```ts
export interface SandboxConfig {
  // Master switch. false = current behavior (no sandbox, full env, no jail).
  enabled: boolean;
  // auto → seatbelt on darwin, bwrap on linux. none = no OS wrapping (env
  // scrub + JS path-jail still apply; bash keeps network + can read anywhere).
  backend: "auto" | "seatbelt" | "bwrap" | "none";
  // Default egress for agent tool subprocesses. Per-ticket `network: true`
  // frontmatter overrides to allow for one ticket.
  network: "deny" | "allow";
  // Extra absolute paths whose reads are denied (added to the built-in secret
  // deny-list). Expanded at load.
  extraDenyRead: string[];
  // Extra absolute paths where writes are permitted (added to worktree+scratch).
  extraAllowWrite: string[];
}
```

Add to the `Config` interface (after the `assess: AssessConfig;` line):

```ts
  // Agent execution sandbox (native OS isolation of tool subprocesses).
  sandbox: SandboxConfig;
```

- [ ] **Step 4: Add the zod section + mapping in `src/config.ts`**

In `TomlSchema` (add immediately after the `verify` section object, before `critic`):

```ts
  sandbox: z
    .object({
      enabled: z.boolean().default(false),
      backend: z.enum(["auto", "seatbelt", "bwrap", "none"]).default("auto"),
      network: z.enum(["deny", "allow"]).default("deny"),
      extra_deny_read: z.array(z.string()).default([]),
      extra_allow_write: z.array(z.string()).default([]),
    })
    .default({}),
```

In `loadConfig`'s returned object (add after the `assess: {...}` block):

```ts
    sandbox: {
      enabled: d.sandbox.enabled,
      backend: d.sandbox.backend,
      network: d.sandbox.network,
      extraDenyRead: d.sandbox.extra_deny_read.map(expandHome),
      extraAllowWrite: d.sandbox.extra_allow_write.map(expandHome),
    },
```

- [ ] **Step 5: Add `sandbox:` to all six test fixtures**

In each of `tests/runOnce.test.ts`, `tests/prFlow.test.ts`, `tests/orphans.test.ts`, `tests/repo.test.ts`, `tests/worktree.test.ts`, `tests/daemon.test.ts`, add this field to the `Config` literal (place it next to the `assess:` field so it is inside the object, before any `...overrides`):

```ts
    sandbox: {
      enabled: false,
      backend: "auto",
      network: "deny",
      extraDenyRead: [],
      extraAllowWrite: [],
    },
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/sandboxConfig.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -12 /tmp/o`
Expected: PASS.
Run: `npm run typecheck > /tmp/tc 2>&1; echo "exit: $?"; tail -20 /tmp/tc`
Expected: exit 0 (no fixture left the `sandbox` field out).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/config.ts tests/sandboxConfig.test.ts tests/runOnce.test.ts tests/prFlow.test.ts tests/orphans.test.ts tests/repo.test.ts tests/worktree.test.ts tests/daemon.test.ts
git commit -m "feat(config): add [sandbox] section (disabled by default)"
```

---

## Task 3: Sandbox filesystem policy

**Files:**
- Create: `src/agent/sandbox/policy.ts`
- Create: `tests/sandboxPolicy.test.ts`

**Interfaces:**
- Consumes: `SandboxConfig` from `../../types.js`.
- Produces:
  - `export interface SandboxPolicy { writableRoots: string[]; readDenyPaths: string[]; network: boolean; scratchDir: string }`
  - `export function builtinDenyReadPaths(home: string): string[]`
  - `export function buildPolicy(opts: { cfg: SandboxConfig; cwd: string; scratchDir: string; home: string; stateDir: string; network: boolean }): SandboxPolicy`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sandboxPolicy.test.ts
import { describe, it, expect } from "vitest";
import { builtinDenyReadPaths, buildPolicy } from "../src/agent/sandbox/policy.js";

describe("builtinDenyReadPaths", () => {
  it("covers the standard secret locations under home", () => {
    const p = builtinDenyReadPaths("/home/x");
    expect(p).toContain("/home/x/.ssh");
    expect(p).toContain("/home/x/.aws");
    expect(p).toContain("/home/x/.config/gh");
    expect(p).toContain("/home/x/.gnupg");
    expect(p).toContain("/home/x/.pi");
  });
});

describe("buildPolicy", () => {
  const base = {
    cfg: {
      enabled: true,
      backend: "auto" as const,
      network: "deny" as const,
      extraDenyRead: ["/extra/secret"],
      extraAllowWrite: ["/extra/writable"],
    },
    cwd: "/work/tree",
    scratchDir: "/tmp/scratch1",
    home: "/home/x",
    stateDir: "/home/x/.local/state/junco",
    network: false,
  };

  it("writable roots = cwd + scratch + extras", () => {
    const pol = buildPolicy(base);
    expect(pol.writableRoots).toEqual(["/work/tree", "/tmp/scratch1", "/extra/writable"]);
  });

  it("read denials = builtins + stateDir + extras", () => {
    const pol = buildPolicy(base);
    expect(pol.readDenyPaths).toContain("/home/x/.ssh");
    expect(pol.readDenyPaths).toContain("/home/x/.local/state/junco");
    expect(pol.readDenyPaths).toContain("/extra/secret");
  });

  it("threads the network flag through", () => {
    expect(buildPolicy({ ...base, network: true }).network).toBe(true);
    expect(buildPolicy({ ...base, network: false }).network).toBe(false);
  });

  it("resolves relative/~ inputs to absolute", () => {
    const pol = buildPolicy({ ...base, cwd: "/work/../work/tree" });
    expect(pol.writableRoots[0]).toBe("/work/tree");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sandboxPolicy.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -20 /tmp/o`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/agent/sandbox/policy.ts
import { resolve, join } from "node:path";
import type { SandboxConfig } from "../../types.js";

/** Absolute paths whose reads are always denied inside the sandbox. Not
 *  operator-removable (extra_deny_read only adds). */
export function builtinDenyReadPaths(home: string): string[] {
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".config", "gh"),
    join(home, ".gnupg"),
    join(home, ".pi"),
  ];
}

export interface SandboxPolicy {
  /** Absolute roots the agent may write under (worktree, scratch, extras). */
  writableRoots: string[];
  /** Absolute subpaths whose reads are denied (secrets, state, extras). */
  readDenyPaths: string[];
  /** true = network egress permitted; false = denied. */
  network: boolean;
  /** Per-session scratch dir (also the redirected TMPDIR). */
  scratchDir: string;
}

export function buildPolicy(opts: {
  cfg: SandboxConfig;
  cwd: string;
  scratchDir: string;
  home: string;
  stateDir: string;
  network: boolean;
}): SandboxPolicy {
  const { cfg, cwd, scratchDir, home, stateDir, network } = opts;
  const writableRoots = [
    resolve(cwd),
    resolve(scratchDir),
    ...cfg.extraAllowWrite.map((p) => resolve(p)),
  ];
  const readDenyPaths = [
    ...builtinDenyReadPaths(home).map((p) => resolve(p)),
    resolve(stateDir),
    ...cfg.extraDenyRead.map((p) => resolve(p)),
  ];
  return { writableRoots, readDenyPaths, network, scratchDir: resolve(scratchDir) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sandboxPolicy.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -12 /tmp/o`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/sandbox/policy.ts tests/sandboxPolicy.test.ts
git commit -m "feat(sandbox): filesystem policy (writable roots + read denials)"
```

---

## Task 4: Path-jail assertions

**Files:**
- Create: `src/agent/sandbox/pathJail.ts`
- Create: `tests/sandboxPathJail.test.ts`

**Interfaces:**
- Consumes: `SandboxPolicy` from `./policy.js`.
- Produces:
  - `export class SandboxViolation extends Error {}`
  - `export function resolveWithin(target: string, cwd: string): string` — resolve `~`, absolute, or cwd-relative to an absolute path.
  - `export function isUnderAnyRoot(abs: string, roots: string[]): boolean`
  - `export function isUnderAnyDeny(abs: string, denies: string[]): boolean`
  - `export function assertWriteAllowed(target: string, cwd: string, policy: SandboxPolicy): string` — returns abs path or throws `SandboxViolation`.
  - `export function assertReadAllowed(target: string, cwd: string, policy: SandboxPolicy): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sandboxPathJail.test.ts
import { describe, it, expect } from "vitest";
import {
  resolveWithin,
  isUnderAnyRoot,
  assertWriteAllowed,
  assertReadAllowed,
  SandboxViolation,
} from "../src/agent/sandbox/pathJail.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

const policy: SandboxPolicy = {
  writableRoots: ["/work/tree", "/tmp/scratch"],
  readDenyPaths: ["/home/x/.ssh", "/home/x/.local/state/junco"],
  network: false,
  scratchDir: "/tmp/scratch",
};

describe("resolveWithin", () => {
  it("resolves cwd-relative paths", () => {
    expect(resolveWithin("src/a.ts", "/work/tree")).toBe("/work/tree/src/a.ts");
  });
  it("keeps absolute paths", () => {
    expect(resolveWithin("/etc/passwd", "/work/tree")).toBe("/etc/passwd");
  });
  it("normalizes traversal", () => {
    expect(resolveWithin("../../etc/passwd", "/work/tree")).toBe("/etc/passwd");
  });
});

describe("isUnderAnyRoot", () => {
  it("true for a child, false for a sibling prefix", () => {
    expect(isUnderAnyRoot("/work/tree/src/a", ["/work/tree"])).toBe(true);
    expect(isUnderAnyRoot("/work/tree", ["/work/tree"])).toBe(true);
    expect(isUnderAnyRoot("/work/tree-evil/a", ["/work/tree"])).toBe(false);
  });
});

describe("assertWriteAllowed", () => {
  it("allows writes inside a writable root", () => {
    expect(assertWriteAllowed("src/a.ts", "/work/tree", policy)).toBe("/work/tree/src/a.ts");
  });
  it("blocks writes outside all roots (incl. traversal escape)", () => {
    expect(() => assertWriteAllowed("../../etc/x", "/work/tree", policy)).toThrow(SandboxViolation);
    expect(() => assertWriteAllowed("/home/x/.bashrc", "/work/tree", policy)).toThrow(
      SandboxViolation,
    );
  });
});

describe("assertReadAllowed", () => {
  it("allows a normal read", () => {
    expect(assertReadAllowed("/usr/lib/node", "/work/tree", policy)).toBe("/usr/lib/node");
  });
  it("blocks reads of denied subpaths", () => {
    expect(() => assertReadAllowed("/home/x/.ssh/id_rsa", "/work/tree", policy)).toThrow(
      SandboxViolation,
    );
    expect(() => assertReadAllowed("~/.ssh/id_rsa".replace("~", "/home/x"), "/work/tree", policy),
    ).toThrow(SandboxViolation);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sandboxPathJail.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -20 /tmp/o`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/agent/sandbox/pathJail.ts
import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { SandboxPolicy } from "./policy.js";

/** Thrown when a tool operation targets a path outside its allowed scope. */
export class SandboxViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxViolation";
  }
}

/** Resolve a tool-supplied path (relative, absolute, or ~-prefixed) to an
 *  absolute, normalized path. Traversal (`..`) is normalized away by resolve. */
export function resolveWithin(target: string, cwd: string): string {
  let t = target;
  if (t === "~") t = homedir();
  else if (t.startsWith("~/")) t = resolve(homedir(), t.slice(2));
  return resolve(cwd, t);
}

function isUnder(abs: string, root: string): boolean {
  const r = resolve(root);
  return abs === r || abs.startsWith(r + sep);
}

export function isUnderAnyRoot(abs: string, roots: string[]): boolean {
  return roots.some((r) => isUnder(abs, r));
}

export function isUnderAnyDeny(abs: string, denies: string[]): boolean {
  return denies.some((d) => isUnder(abs, d));
}

export function assertWriteAllowed(target: string, cwd: string, policy: SandboxPolicy): string {
  const abs = resolveWithin(target, cwd);
  if (!isUnderAnyRoot(abs, policy.writableRoots)) {
    throw new SandboxViolation(`sandbox: write denied outside worktree/scratch: ${abs}`);
  }
  return abs;
}

export function assertReadAllowed(target: string, cwd: string, policy: SandboxPolicy): string {
  const abs = resolveWithin(target, cwd);
  if (isUnderAnyDeny(abs, policy.readDenyPaths)) {
    throw new SandboxViolation(`sandbox: read denied (protected path): ${abs}`);
  }
  return abs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sandboxPathJail.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -12 /tmp/o`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/sandbox/pathJail.ts tests/sandboxPathJail.test.ts
git commit -m "feat(sandbox): path-jail assertions for tool fs operations"
```

---

## Task 5: Sandbox backends (Seatbelt / bubblewrap / none)

**Files:**
- Create: `src/agent/sandbox/backend.ts`
- Create: `tests/sandboxBackend.test.ts`

**Interfaces:**
- Consumes: `SandboxPolicy` from `./policy.js`; `SandboxConfig["backend"]` from `../../types.js`.
- Produces:
  - `export type ExecProbe = (cmd: string, args: string[]) => Promise<{ code: number }>`
  - `export interface SandboxBackend { name: "seatbelt" | "bwrap" | "none"; spawnArgv(command: string, policy: SandboxPolicy): string[]; isAvailable(exec: ExecProbe): Promise<boolean> }`
  - `export function seatbeltProfile(policy: SandboxPolicy): string`
  - `export function bwrapArgs(policy: SandboxPolicy): string[]`
  - `export const seatbeltBackend`, `bwrapBackend`, `noneBackend: SandboxBackend`
  - `export function selectBackend(backend: "auto"|"seatbelt"|"bwrap"|"none", platform: NodeJS.Platform): SandboxBackend`
  - `export const defaultExecProbe: ExecProbe`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sandboxBackend.test.ts
import { describe, it, expect } from "vitest";
import {
  seatbeltProfile,
  bwrapArgs,
  seatbeltBackend,
  bwrapBackend,
  noneBackend,
  selectBackend,
} from "../src/agent/sandbox/backend.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

const denyNet: SandboxPolicy = {
  writableRoots: ["/work/tree", "/tmp/scratch"],
  readDenyPaths: ["/home/x/.ssh"],
  network: false,
  scratchDir: "/tmp/scratch",
};
const allowNet: SandboxPolicy = { ...denyNet, network: true };

describe("seatbeltProfile", () => {
  it("denies default, allows writes only under the roots, and denies network", () => {
    const p = seatbeltProfile(denyNet);
    expect(p).toContain("(version 1)");
    expect(p).toContain("(deny default)");
    expect(p).toContain('(subpath "/work/tree")');
    expect(p).toContain('(subpath "/tmp/scratch")');
    expect(p).toContain('(deny file-read* (subpath "/home/x/.ssh"))');
    expect(p).toContain("(deny network*)");
  });
  it("allows network when policy.network is true", () => {
    const p = seatbeltProfile(allowNet);
    expect(p).toContain("(allow network*)");
    expect(p).not.toContain("(deny network*)");
  });
});

describe("seatbeltBackend.spawnArgv", () => {
  it("passes the profile inline and runs bash -c", () => {
    const argv = seatbeltBackend.spawnArgv("echo hi", denyNet);
    expect(argv[0]).toBe("sandbox-exec");
    expect(argv[1]).toBe("-p");
    expect(argv[2]).toContain("(deny default)");
    expect(argv.slice(3)).toEqual(["/bin/bash", "-c", "echo hi"]);
  });
});

describe("bwrapArgs", () => {
  it("ro-binds root, rw-binds writable roots, masks denials, unshares net when denied", () => {
    const a = bwrapArgs(denyNet).join(" ");
    expect(a).toContain("--ro-bind / /");
    expect(a).toContain("--bind /work/tree /work/tree");
    expect(a).toContain("--bind /tmp/scratch /tmp/scratch");
    expect(a).toContain("--tmpfs /home/x/.ssh");
    expect(a).toContain("--unshare-net");
  });
  it("does not unshare net when network is allowed", () => {
    expect(bwrapArgs(allowNet).join(" ")).not.toContain("--unshare-net");
  });
});

describe("bwrapBackend.spawnArgv", () => {
  it("prefixes bwrap args and runs bash -c", () => {
    const argv = bwrapBackend.spawnArgv("echo hi", denyNet);
    expect(argv[0]).toBe("bwrap");
    expect(argv.slice(-3)).toEqual(["/bin/bash", "-c", "echo hi"]);
  });
});

describe("noneBackend", () => {
  it("runs bash -c directly and is always available", async () => {
    expect(noneBackend.spawnArgv("echo hi", denyNet)).toEqual(["/bin/bash", "-c", "echo hi"]);
    expect(await noneBackend.isAvailable(async () => ({ code: 127 }))).toBe(true);
  });
});

describe("selectBackend", () => {
  it("auto → seatbelt on darwin, bwrap on linux", () => {
    expect(selectBackend("auto", "darwin").name).toBe("seatbelt");
    expect(selectBackend("auto", "linux").name).toBe("bwrap");
  });
  it("explicit backends win regardless of platform", () => {
    expect(selectBackend("bwrap", "darwin").name).toBe("bwrap");
    expect(selectBackend("seatbelt", "linux").name).toBe("seatbelt");
    expect(selectBackend("none", "darwin").name).toBe("none");
  });
  it("auto on an unsupported platform yields none", () => {
    expect(selectBackend("auto", "win32").name).toBe("none");
  });
});

describe("isAvailable", () => {
  it("seatbelt available when probe exits 0", async () => {
    expect(await seatbeltBackend.isAvailable(async () => ({ code: 0 }))).toBe(true);
    expect(await seatbeltBackend.isAvailable(async () => ({ code: 127 }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sandboxBackend.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -20 /tmp/o`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/agent/sandbox/backend.ts
import { execFile } from "node:child_process";
import type { SandboxPolicy } from "./policy.js";

export type ExecProbe = (cmd: string, args: string[]) => Promise<{ code: number }>;

export interface SandboxBackend {
  name: "seatbelt" | "bwrap" | "none";
  /** Full argv (binary + args) that runs `command` under the sandbox. */
  spawnArgv(command: string, policy: SandboxPolicy): string[];
  /** Whether the backend can actually run here (binary present + functional). */
  isAvailable(exec: ExecProbe): Promise<boolean>;
}

/** Default probe: run a binary, treat ENOENT as code 127 (mirrors doctor.ts). */
export const defaultExecProbe: ExecProbe = (cmd, args) =>
  new Promise((res) => {
    execFile(cmd, args, { timeout: 10_000 }, (err) => {
      const code = err ? ((err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1) : 0;
      res({ code });
    });
  });

// ---- macOS Seatbelt (sandbox-exec + SBPL) --------------------------------

/** Generate an SBPL profile: deny by default; broad read minus denied
 *  subpaths; write only under the writable roots; network per policy. */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow signal (target self))",
    "(allow file-read*)",
  ];
  for (const d of policy.readDenyPaths) lines.push(`(deny file-read* (subpath ${q(d)}))`);
  const writes = policy.writableRoots.map((r) => `(subpath ${q(r)})`).join(" ");
  lines.push(`(allow file-write* ${writes} (literal "/dev/null") (literal "/dev/dtracehelper"))`);
  lines.push(policy.network ? "(allow network*)" : "(deny network*)");
  return lines.join("\n");
}

/** Quote a path for SBPL (double-quoted string literal). */
function q(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export const seatbeltBackend: SandboxBackend = {
  name: "seatbelt",
  spawnArgv(command, policy) {
    return ["sandbox-exec", "-p", seatbeltProfile(policy), "/bin/bash", "-c", command];
  },
  async isAvailable(exec) {
    // A trivial allow-all profile that must run `true` successfully.
    const r = await exec("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]);
    return r.code === 0;
  },
};

// ---- Linux bubblewrap ----------------------------------------------------

/** bwrap args: read-only root, rw-bind writable roots, tmpfs-mask denied
 *  read paths, private /dev+/proc+/tmp, unshare net when denied. */
export function bwrapArgs(policy: SandboxPolicy): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const r of policy.writableRoots) args.push("--bind", r, r);
  for (const d of policy.readDenyPaths) args.push("--tmpfs", d);
  args.push("--unshare-pid");
  if (!policy.network) args.push("--unshare-net");
  args.push("--die-with-parent");
  return args;
}

export const bwrapBackend: SandboxBackend = {
  name: "bwrap",
  spawnArgv(command, policy) {
    return ["bwrap", ...bwrapArgs(policy), "/bin/bash", "-c", command];
  },
  async isAvailable(exec) {
    const r = await exec("bwrap", ["--ro-bind", "/", "/", "--unshare-net", "/usr/bin/true"]);
    return r.code === 0;
  },
};

// ---- No OS wrapping ------------------------------------------------------

export const noneBackend: SandboxBackend = {
  name: "none",
  spawnArgv(command) {
    return ["/bin/bash", "-c", command];
  },
  async isAvailable() {
    return true;
  },
};

export function selectBackend(
  backend: "auto" | "seatbelt" | "bwrap" | "none",
  platform: NodeJS.Platform,
): SandboxBackend {
  if (backend === "seatbelt") return seatbeltBackend;
  if (backend === "bwrap") return bwrapBackend;
  if (backend === "none") return noneBackend;
  // auto:
  if (platform === "darwin") return seatbeltBackend;
  if (platform === "linux") return bwrapBackend;
  return noneBackend;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sandboxBackend.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -12 /tmp/o`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/sandbox/backend.ts tests/sandboxBackend.test.ts
git commit -m "feat(sandbox): seatbelt/bwrap/none backends with argv + profiles"
```

---

## Task 6: Sandboxed bash operations

**Files:**
- Create: `src/agent/sandbox/bashOps.ts`
- Create: `tests/sandboxBashOps.test.ts`

**Interfaces:**
- Consumes: `SandboxBackend` from `./backend.js`; `SandboxPolicy` from `./policy.js`; `scrubEnv` from `../../scrubEnv.js`.
- Produces (local structural type mirroring the SDK's `BashOperations` so no SDK import is needed):
  - `export interface BashExecOptions { onData: (d: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }`
  - `export interface BashOperationsLike { exec: (command: string, cwd: string, options: BashExecOptions) => Promise<{ exitCode: number | null }> }`
  - `export interface BashOpsDeps { spawnFn?: typeof import("node:child_process").spawn; env?: () => Record<string, string> }`
  - `export function makeSandboxedBashOperations(backend: SandboxBackend, policy: SandboxPolicy, deps?: BashOpsDeps): BashOperationsLike`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sandboxBashOps.test.ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { makeSandboxedBashOperations } from "../src/agent/sandbox/bashOps.js";
import { noneBackend, seatbeltBackend } from "../src/agent/sandbox/backend.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

const policy: SandboxPolicy = {
  writableRoots: ["/work/tree"],
  readDenyPaths: [],
  network: false,
  scratchDir: "/tmp/scratch",
};

/** A fake child process the fake spawn returns; drive it in the test. */
function fakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

describe("makeSandboxedBashOperations", () => {
  it("spawns the backend argv, scrubs env, redirects TMPDIR to scratch", async () => {
    const proc = fakeProc();
    const spawnFn = vi.fn(() => proc) as any;
    const ops = makeSandboxedBashOperations(seatbeltBackend, policy, {
      spawnFn,
      env: () => ({ PATH: "/usr/bin", GH_TOKEN: "leak" }),
    });
    const p = ops.exec("echo hi", "/work/tree", { onData: () => {} });
    // Drive the fake process to completion.
    proc.stdout.emit("data", Buffer.from("hi\n"));
    proc.emit("close", 0);
    const res = await p;

    expect(res.exitCode).toBe(0);
    const [bin, args, spawnOpts] = spawnFn.mock.calls[0];
    expect(bin).toBe("sandbox-exec");
    expect(args).toContain("/bin/bash");
    // Env is scrubbed (no GH_TOKEN) and TMPDIR points at scratch.
    expect(spawnOpts.env.GH_TOKEN).toBeUndefined();
    expect(spawnOpts.env.PATH).toBe("/usr/bin");
    expect(spawnOpts.env.TMPDIR).toBe("/tmp/scratch");
    expect(spawnOpts.cwd).toBe("/work/tree");
  });

  it("streams stdout+stderr through onData", async () => {
    const proc = fakeProc();
    const chunks: string[] = [];
    const ops = makeSandboxedBashOperations(noneBackend, policy, { spawnFn: (() => proc) as any });
    const p = ops.exec("x", "/work/tree", { onData: (d) => chunks.push(d.toString()) });
    proc.stdout.emit("data", Buffer.from("out"));
    proc.stderr.emit("data", Buffer.from("err"));
    proc.emit("close", 3);
    const res = await p;
    expect(res.exitCode).toBe(3);
    expect(chunks.join("")).toBe("outerr");
  });

  it("kills the process on timeout and resolves exitCode null", async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    const ops = makeSandboxedBashOperations(noneBackend, policy, { spawnFn: (() => proc) as any });
    const p = ops.exec("sleep", "/work/tree", { onData: () => {}, timeout: 1000 });
    vi.advanceTimersByTime(1001);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    proc.emit("close", null);
    const res = await p;
    expect(res.exitCode).toBeNull();
    vi.useRealTimers();
  });

  it("kills on abort signal", async () => {
    const proc = fakeProc();
    const ac = new AbortController();
    const ops = makeSandboxedBashOperations(noneBackend, policy, { spawnFn: (() => proc) as any });
    const p = ops.exec("x", "/work/tree", { onData: () => {}, signal: ac.signal });
    ac.abort();
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    proc.emit("close", null);
    await p;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sandboxBashOps.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -20 /tmp/o`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/agent/sandbox/bashOps.ts
import { spawn as realSpawn } from "node:child_process";
import { scrubEnv } from "../../scrubEnv.js";
import type { SandboxBackend } from "./backend.js";
import type { SandboxPolicy } from "./policy.js";

/** Structural mirror of the SDK's BashOperations.exec options (no SDK import). */
export interface BashExecOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

/** Structural mirror of the SDK's BashOperations interface. */
export interface BashOperationsLike {
  exec: (
    command: string,
    cwd: string,
    options: BashExecOptions,
  ) => Promise<{ exitCode: number | null }>;
}

export interface BashOpsDeps {
  spawnFn?: typeof realSpawn;
  /** Source env before scrubbing; defaults to process.env. Injectable for tests. */
  env?: () => Record<string, string | undefined>;
}

/**
 * Build a BashOperations that runs the model's command under the OS sandbox
 * backend with a scrubbed env (no GH_TOKEN / API keys) and TMPDIR redirected to
 * the per-session scratch dir. Ignores any caller-supplied env — the scrubbed
 * env is built fresh so credential containment never depends on the caller.
 */
export function makeSandboxedBashOperations(
  backend: SandboxBackend,
  policy: SandboxPolicy,
  deps: BashOpsDeps = {},
): BashOperationsLike {
  const spawnFn = deps.spawnFn ?? realSpawn;
  const envSource = deps.env ?? (() => process.env);

  return {
    exec(command, cwd, options) {
      const [bin, ...args] = backend.spawnArgv(command, policy);
      const env = { ...scrubEnv(envSource()), TMPDIR: policy.scratchDir };

      return new Promise<{ exitCode: number | null }>((resolve) => {
        const proc = spawnFn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
        let settled = false;
        const finish = (exitCode: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (options.signal) options.signal.removeEventListener("abort", onAbort);
          resolve({ exitCode });
        };

        proc.stdout?.on("data", (c: Buffer) => options.onData(c));
        proc.stderr?.on("data", (c: Buffer) => options.onData(c));

        const timer = options.timeout
          ? setTimeout(() => proc.kill("SIGKILL"), options.timeout)
          : undefined;

        const onAbort = (): void => proc.kill("SIGKILL");
        if (options.signal) {
          if (options.signal.aborted) proc.kill("SIGKILL");
          else options.signal.addEventListener("abort", onAbort);
        }

        proc.on("error", () => finish(null));
        proc.on("close", (code: number | null) => finish(code));
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sandboxBashOps.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -12 /tmp/o`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/sandbox/bashOps.ts tests/sandboxBashOps.test.ts
git commit -m "feat(sandbox): sandboxed bash operations (argv spawn + scrubbed env)"
```

---

## Task 7: Jailed filesystem operations

**Files:**
- Create: `src/agent/sandbox/fsOps.ts`
- Create: `tests/sandboxFsOps.test.ts`

**Interfaces:**
- Consumes: `SandboxPolicy` from `./policy.js`; `assertReadAllowed`/`assertWriteAllowed` from `./pathJail.js`.
- Produces (local structural types mirroring the SDK Operations; each wraps `node:fs/promises` with a jail check):
  - `export function makeJailedReadOperations(cwd: string, policy: SandboxPolicy): ReadOperationsLike`
  - `export function makeJailedWriteOperations(cwd: string, policy: SandboxPolicy): WriteOperationsLike`
  - `export function makeJailedEditOperations(cwd: string, policy: SandboxPolicy): EditOperationsLike`
  - `export function makeJailedLsOperations(cwd: string, policy: SandboxPolicy): LsOperationsLike`
  - `export function makeJailedFindOperations(cwd: string, policy: SandboxPolicy): FindOperationsLike`
  - `export function makeJailedGrepOperations(cwd: string, policy: SandboxPolicy): GrepOperationsLike`

Note on shapes (verified against SDK 0.80.3): `ReadOperations { readFile(abs)→Buffer; access(abs)→void; detectImageMimeType?(abs) }`; `WriteOperations { writeFile(abs,content); mkdir(dir) }`; `EditOperations { readFile(abs)→Buffer; writeFile(abs,content); access(abs) }`; `LsOperations { exists(abs); stat(abs)→{isDirectory()}; readdir(abs)→string[] }`; `FindOperations { exists(abs); glob(pattern,cwd,{ignore,limit})→string[] }`; `GrepOperations { isDirectory(abs)→boolean; readFile(abs)→string }`. The SDK passes **absolute** paths to Operations (it resolves cwd/`~` first), so the jail re-asserts on the absolute path (defense in depth; the jail also normalizes traversal).

- [ ] **Step 1: Write the failing test**

```ts
// tests/sandboxFsOps.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  makeJailedReadOperations,
  makeJailedWriteOperations,
  makeJailedEditOperations,
} from "../src/agent/sandbox/fsOps.js";
import { SandboxViolation } from "../src/agent/sandbox/pathJail.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "junco-fsops-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function policyFor(work: string, deny: string[] = []): SandboxPolicy {
  return { writableRoots: [work], readDenyPaths: deny, network: false, scratchDir: work };
}

describe("jailed read", () => {
  it("reads an allowed file, blocks a denied subpath", async () => {
    const work = tmp();
    writeFileSync(join(work, "a.txt"), "hello");
    const secret = tmp();
    writeFileSync(join(secret, "id_rsa"), "KEY");
    const ops = makeJailedReadOperations(work, policyFor(work, [secret]));
    expect((await ops.readFile(join(work, "a.txt"))).toString()).toBe("hello");
    await expect(ops.readFile(join(secret, "id_rsa"))).rejects.toBeInstanceOf(SandboxViolation);
    await expect(ops.access(join(secret, "id_rsa"))).rejects.toBeInstanceOf(SandboxViolation);
  });
});

describe("jailed write", () => {
  it("writes inside the root, blocks outside", async () => {
    const work = tmp();
    const outside = tmp();
    const ops = makeJailedWriteOperations(work, policyFor(work));
    await ops.writeFile(join(work, "out.txt"), "ok");
    await expect(ops.writeFile(join(outside, "x.txt"), "no")).rejects.toBeInstanceOf(
      SandboxViolation,
    );
    // mkdir jailed too
    await ops.mkdir(join(work, "sub"));
    await expect(ops.mkdir(join(outside, "sub"))).rejects.toBeInstanceOf(SandboxViolation);
  });
});

describe("jailed edit", () => {
  it("access requires the path to be writable (read+write)", async () => {
    const work = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "f.txt"), "x");
    const ops = makeJailedEditOperations(work, policyFor(work));
    await expect(ops.access(join(outside, "f.txt"))).rejects.toBeInstanceOf(SandboxViolation);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sandboxFsOps.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -20 /tmp/o`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/agent/sandbox/fsOps.ts
import { readFile, writeFile, mkdir, access, stat, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { assertReadAllowed, assertWriteAllowed } from "./pathJail.js";
import type { SandboxPolicy } from "./policy.js";

export interface ReadOperationsLike {
  readFile: (abs: string) => Promise<Buffer>;
  access: (abs: string) => Promise<void>;
  detectImageMimeType?: (abs: string) => Promise<string | null | undefined>;
}
export interface WriteOperationsLike {
  writeFile: (abs: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}
export interface EditOperationsLike {
  readFile: (abs: string) => Promise<Buffer>;
  writeFile: (abs: string, content: string) => Promise<void>;
  access: (abs: string) => Promise<void>;
}
export interface LsOperationsLike {
  exists: (abs: string) => Promise<boolean>;
  stat: (abs: string) => Promise<{ isDirectory: () => boolean }>;
  readdir: (abs: string) => Promise<string[]>;
}
export interface FindOperationsLike {
  exists: (abs: string) => Promise<boolean>;
  glob: (
    pattern: string,
    cwd: string,
    options: { ignore: string[]; limit: number },
  ) => Promise<string[]>;
}
export interface GrepOperationsLike {
  isDirectory: (abs: string) => Promise<boolean>;
  readFile: (abs: string) => Promise<string>;
}

export function makeJailedReadOperations(cwd: string, policy: SandboxPolicy): ReadOperationsLike {
  const R = (p: string): string => assertReadAllowed(p, cwd, policy);
  return {
    readFile: (p) => readFile(R(p)),
    access: (p) => access(R(p), constants.R_OK),
  };
}

export function makeJailedWriteOperations(cwd: string, policy: SandboxPolicy): WriteOperationsLike {
  const W = (p: string): string => assertWriteAllowed(p, cwd, policy);
  return {
    writeFile: (p, content) => writeFile(W(p), content),
    mkdir: async (dir) => {
      await mkdir(W(dir), { recursive: true });
    },
  };
}

export function makeJailedEditOperations(cwd: string, policy: SandboxPolicy): EditOperationsLike {
  const R = (p: string): string => assertReadAllowed(p, cwd, policy);
  const W = (p: string): string => assertWriteAllowed(p, cwd, policy);
  return {
    readFile: (p) => readFile(R(p)),
    writeFile: (p, content) => writeFile(W(p), content),
    // Editing requires write scope; assert write (also normalizes traversal).
    access: async (p) => {
      W(p);
      await access(R(p), constants.R_OK);
    },
  };
}

export function makeJailedLsOperations(cwd: string, policy: SandboxPolicy): LsOperationsLike {
  const R = (p: string): string => assertReadAllowed(p, cwd, policy);
  return {
    exists: async (p) => {
      try {
        await access(R(p));
        return true;
      } catch {
        return false;
      }
    },
    stat: (p) => stat(R(p)),
    readdir: (p) => readdir(R(p)),
  };
}

export function makeJailedFindOperations(cwd: string, policy: SandboxPolicy): FindOperationsLike {
  const R = (p: string): string => assertReadAllowed(p, cwd, policy);
  return {
    exists: async (p) => {
      try {
        await access(R(p));
        return true;
      } catch {
        return false;
      }
    },
    glob: async (pattern, gcwd, options) => {
      // Confine the search root; the SDK passes an absolute cwd here.
      const { glob } = await import("node:fs/promises");
      const root = R(gcwd);
      const out: string[] = [];
      for await (const entry of glob(pattern, { cwd: root, exclude: options.ignore } as never)) {
        out.push(entry as string);
        if (out.length >= options.limit) break;
      }
      return out;
    },
  };
}

export function makeJailedGrepOperations(cwd: string, policy: SandboxPolicy): GrepOperationsLike {
  const R = (p: string): string => assertReadAllowed(p, cwd, policy);
  return {
    isDirectory: async (p) => (await stat(R(p))).isDirectory(),
    readFile: async (p) => (await readFile(R(p))).toString(),
  };
}
```

Note: `node:fs/promises` `glob` requires Node ≥ 22 (available; engines floor is 22.19). If `glob` import proves unavailable at runtime in Step 4, replace the `find` glob body with a `readdir`-based recursive walk confined to `root` — but do not change the jail semantics.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sandboxFsOps.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -12 /tmp/o`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/sandbox/fsOps.ts tests/sandboxFsOps.test.ts
git commit -m "feat(sandbox): jailed fs operations for read/write/edit/ls/find/grep"
```

---

## Task 8: `buildSandbox` glue + `SandboxUnavailableError`

**Files:**
- Create: `src/agent/sandbox/index.ts`
- Create: `tests/sandboxBuild.test.ts`

**Interfaces:**
- Consumes: everything above; `SandboxConfig` from `../../types.js`.
- Produces:
  - `export class SandboxUnavailableError extends Error {}`
  - `export interface SdkToolFactories { createToolDefinition: (name: string, cwd: string, options: unknown) => unknown; DefaultResourceLoader: new (o: { cwd: string; agentDir: string; noExtensions?: boolean }) => unknown }`
  - `export interface BuildSandboxOpts { cwd: string; toolNames: string[]; backend: SandboxBackend; policy: SandboxPolicy; home: string; bashDeps?: BashOpsDeps }`
  - `export interface BuildSandboxResult { customTools: unknown[]; resourceLoader: unknown }`
  - `export function buildSandbox(f: SdkToolFactories, opts: BuildSandboxOpts): BuildSandboxResult`
  - `export function toolsOptionsFor(name: string, cwd: string, backend: SandboxBackend, policy: SandboxPolicy, bashDeps?: BashOpsDeps): Record<string, unknown>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sandboxBuild.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildSandbox, toolsOptionsFor } from "../src/agent/sandbox/index.js";
import { noneBackend } from "../src/agent/sandbox/backend.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

const policy: SandboxPolicy = {
  writableRoots: ["/work/tree"],
  readDenyPaths: ["/home/x/.ssh"],
  network: false,
  scratchDir: "/tmp/s",
};

describe("toolsOptionsFor", () => {
  it("wires bash operations for bash", () => {
    const o = toolsOptionsFor("bash", "/work/tree", noneBackend, policy) as any;
    expect(typeof o.bash.operations.exec).toBe("function");
  });
  it("wires read/write/edit/ls/find/grep operations", () => {
    for (const [name, key] of [
      ["read", "read"],
      ["write", "write"],
      ["edit", "edit"],
      ["ls", "ls"],
      ["find", "find"],
      ["grep", "grep"],
    ] as const) {
      const o = toolsOptionsFor(name, "/work/tree", noneBackend, policy) as any;
      expect(o[key].operations).toBeTruthy();
    }
  });
});

describe("buildSandbox", () => {
  it("builds one custom tool per allowlisted name and a noExtensions loader", () => {
    const created: Array<{ name: string; cwd: string; options: any }> = [];
    const loaderOpts: any[] = [];
    const factories = {
      createToolDefinition: (name: string, cwd: string, options: unknown) => {
        created.push({ name, cwd, options });
        return { __tool: name };
      },
      DefaultResourceLoader: class {
        constructor(o: any) {
          loaderOpts.push(o);
        }
      },
    };
    const res = buildSandbox(factories as any, {
      cwd: "/work/tree",
      toolNames: ["read", "bash", "write"],
      backend: noneBackend,
      policy,
      home: "/home/x",
    });
    expect(created.map((c) => c.name)).toEqual(["read", "bash", "write"]);
    expect(res.customTools).toEqual([{ __tool: "read" }, { __tool: "bash" }, { __tool: "write" }]);
    expect(loaderOpts[0]).toMatchObject({
      cwd: "/work/tree",
      agentDir: "/home/x/.pi/agent",
      noExtensions: true,
    });
    expect(res.resourceLoader).toBeInstanceOf(factories.DefaultResourceLoader);
  });

  it("ignores tool names the SDK does not know (e.g. todo_write)", () => {
    const factories = {
      createToolDefinition: (name: string) => ({ __tool: name }),
      DefaultResourceLoader: class {
        constructor(_: any) {}
      },
    };
    const res = buildSandbox(factories as any, {
      cwd: "/work/tree",
      toolNames: ["read", "todo_write"],
      backend: noneBackend,
      policy,
      home: "/home/x",
    });
    expect(res.customTools).toEqual([{ __tool: "read" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sandboxBuild.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -20 /tmp/o`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/agent/sandbox/index.ts
import { join } from "node:path";
import type { SandboxBackend } from "./backend.js";
import type { SandboxPolicy } from "./policy.js";
import { makeSandboxedBashOperations, type BashOpsDeps } from "./bashOps.js";
import {
  makeJailedReadOperations,
  makeJailedWriteOperations,
  makeJailedEditOperations,
  makeJailedLsOperations,
  makeJailedFindOperations,
  makeJailedGrepOperations,
} from "./fsOps.js";

/** Thrown (fail-closed) when a sandbox backend is required but unavailable. */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/** The seven built-in Pi tool names we know how to sandbox. */
const KNOWN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface SdkToolFactories {
  createToolDefinition: (name: string, cwd: string, options: unknown) => unknown;
  DefaultResourceLoader: new (o: {
    cwd: string;
    agentDir: string;
    noExtensions?: boolean;
  }) => unknown;
}

export interface BuildSandboxOpts {
  cwd: string;
  toolNames: string[];
  backend: SandboxBackend;
  policy: SandboxPolicy;
  home: string;
  bashDeps?: BashOpsDeps;
}

export interface BuildSandboxResult {
  customTools: unknown[];
  resourceLoader: unknown;
}

/** Build the ToolsOptions object that gives one tool its sandboxed operations. */
export function toolsOptionsFor(
  name: string,
  cwd: string,
  backend: SandboxBackend,
  policy: SandboxPolicy,
  bashDeps?: BashOpsDeps,
): Record<string, unknown> {
  switch (name) {
    case "bash":
      return { bash: { operations: makeSandboxedBashOperations(backend, policy, bashDeps) } };
    case "read":
      return { read: { operations: makeJailedReadOperations(cwd, policy) } };
    case "write":
      return { write: { operations: makeJailedWriteOperations(cwd, policy) } };
    case "edit":
      return { edit: { operations: makeJailedEditOperations(cwd, policy) } };
    case "ls":
      return { ls: { operations: makeJailedLsOperations(cwd, policy) } };
    case "find":
      return { find: { operations: makeJailedFindOperations(cwd, policy) } };
    case "grep":
      return { grep: { operations: makeJailedGrepOperations(cwd, policy) } };
    default:
      return {};
  }
}

/**
 * Build sandboxed custom tools + a no-extensions resource loader. `factories`
 * are the SDK functions (passed in from makePiSessionFactory's dynamic import)
 * so this module stays SDK-free and unit-testable with fakes.
 */
export function buildSandbox(
  factories: SdkToolFactories,
  opts: BuildSandboxOpts,
): BuildSandboxResult {
  const { cwd, toolNames, backend, policy, home, bashDeps } = opts;
  const customTools = toolNames
    .filter((n) => KNOWN_TOOLS.has(n))
    .map((n) =>
      factories.createToolDefinition(n, cwd, toolsOptionsFor(n, cwd, backend, policy, bashDeps)),
    );
  const resourceLoader = new factories.DefaultResourceLoader({
    cwd,
    agentDir: join(home, ".pi", "agent"),
    noExtensions: true,
  });
  return { customTools, resourceLoader };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sandboxBuild.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -12 /tmp/o`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/sandbox/index.ts tests/sandboxBuild.test.ts
git commit -m "feat(sandbox): buildSandbox glue (custom tools + no-ext loader)"
```

---

## Task 9: Verify the SDK deep-import surface (spike)

This task confirms, against the installed SDK, the exact runtime import paths for `createToolDefinition` and `DefaultResourceLoader` used by Task 10. No production code file is the deliverable — a passing probe test is.

**Files:**
- Create: `tests/sdkImportSurface.test.ts`

- [ ] **Step 1: Write the probe test**

```ts
// tests/sdkImportSurface.test.ts
import { describe, it, expect } from "vitest";

describe("Pi SDK import surface (sandbox wiring depends on these)", () => {
  it("DefaultResourceLoader is on the package root", async () => {
    const mod = await import("@earendil-works/pi-coding-agent");
    expect(typeof (mod as any).DefaultResourceLoader).toBe("function");
  });

  it("createToolDefinition is reachable (root or deep import)", async () => {
    let fn: unknown;
    try {
      fn = (await import("@earendil-works/pi-coding-agent")).createToolDefinition;
    } catch {
      /* fall through */
    }
    if (!fn) {
      const deep = await import("@earendil-works/pi-coding-agent/dist/core/tools/index.js");
      fn = (deep as any).createToolDefinition;
    }
    expect(typeof fn).toBe("function");
  });
});
```

- [ ] **Step 2: Run the probe**

Run: `npx vitest run tests/sdkImportSurface.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -25 /tmp/o`
Expected: PASS. **If the deep import throws `ERR_PACKAGE_PATH_NOT_EXPORTED`**, the package `exports` map blocks it — in Task 10 use per-tool deep imports (`.../dist/core/tools/bash.js` exposes `createBashToolDefinition`) or, if those are also blocked, import `createReadOnlyTools`/`createCodingTools` from root and adapt. Record which path worked in a comment in `session.ts`.

- [ ] **Step 3: Commit**

```bash
git add tests/sdkImportSurface.test.ts
git commit -m "test(sandbox): pin the SDK import surface the wiring depends on"
```

---

## Task 10: Wire the sandbox into `makePiSessionFactory`

**Files:**
- Modify: `src/agent/session.ts` (imports; `SessionOverrides`; `makePiSessionFactory` body)
- Create: `tests/sessionSandboxWiring.test.ts`

**Interfaces:**
- Consumes: `buildSandbox`, `SandboxUnavailableError` from `./sandbox/index.js`; `selectBackend`, `defaultExecProbe` from `./sandbox/backend.js`; `buildPolicy` from `./sandbox/policy.js`.
- Produces: `SessionOverrides` gains `network?: boolean`. `makePiSessionFactory` behavior unchanged when `cfg.sandbox.enabled` is false.

- [ ] **Step 1: Write the failing test (behavioral seam)**

Because the session factory does a real SDK import, test the *decision seam* — extract the sandbox setup into an exported helper `resolveSandbox(cfg, cwd, overrides, deps)` that returns `{ backend, policy, scratchDir } | null` and does the fail-closed check, injecting the probe + scratch maker. The factory calls it.

```ts
// tests/sessionSandboxWiring.test.ts
import { describe, it, expect } from "vitest";
import { resolveSandbox } from "../src/agent/session.js";
import { SandboxUnavailableError } from "../src/agent/sandbox/index.js";
import type { Config } from "../src/types.js";

function cfgWith(sandbox: Partial<Config["sandbox"]>): Config {
  // Minimal cast: resolveSandbox only reads cfg.sandbox and cfg.stateDir.
  return {
    stateDir: "/tmp/state",
    sandbox: {
      enabled: true,
      backend: "none",
      network: "deny",
      extraDenyRead: [],
      extraAllowWrite: [],
      ...sandbox,
    },
  } as unknown as Config;
}

describe("resolveSandbox", () => {
  it("returns null when disabled (no-op path)", async () => {
    const r = await resolveSandbox(cfgWith({ enabled: false }), "/work", undefined, {
      probe: async () => ({ code: 0 }),
      makeScratch: () => "/tmp/scratch",
      platform: "linux",
      home: "/home/x",
    });
    expect(r).toBeNull();
  });

  it("builds policy + backend when enabled and available", async () => {
    const r = await resolveSandbox(cfgWith({ backend: "none" }), "/work", undefined, {
      probe: async () => ({ code: 0 }),
      makeScratch: () => "/tmp/scratch",
      platform: "linux",
      home: "/home/x",
    });
    expect(r?.backend.name).toBe("none");
    expect(r?.policy.writableRoots).toContain("/work");
    expect(r?.policy.scratchDir).toBe("/tmp/scratch");
    expect(r?.policy.network).toBe(false);
  });

  it("per-ticket network override widens egress", async () => {
    const r = await resolveSandbox(cfgWith({}), "/work", { network: true }, {
      probe: async () => ({ code: 0 }),
      makeScratch: () => "/tmp/scratch",
      platform: "linux",
      home: "/home/x",
    });
    expect(r?.policy.network).toBe(true);
  });

  it("fails closed when a required backend is unavailable", async () => {
    await expect(
      resolveSandbox(cfgWith({ backend: "bwrap" }), "/work", undefined, {
        probe: async () => ({ code: 127 }),
        makeScratch: () => "/tmp/scratch",
        platform: "linux",
        home: "/home/x",
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("backend=none never fails closed even if a probe would fail", async () => {
    const r = await resolveSandbox(cfgWith({ backend: "none" }), "/work", undefined, {
      probe: async () => ({ code: 127 }),
      makeScratch: () => "/tmp/scratch",
      platform: "linux",
      home: "/home/x",
    });
    expect(r?.backend.name).toBe("none");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sessionSandboxWiring.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -20 /tmp/o`
Expected: FAIL — `resolveSandbox` is not exported.

- [ ] **Step 3: Add imports + `resolveSandbox` + `SessionOverrides.network` to `session.ts`**

Add near the top-of-file first-party imports:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { buildPolicy, type SandboxPolicy } from "./sandbox/policy.js";
import {
  selectBackend,
  defaultExecProbe,
  type SandboxBackend,
  type ExecProbe,
} from "./sandbox/backend.js";
import { buildSandbox, SandboxUnavailableError } from "./sandbox/index.js";
```

(Note: `dirname` is already imported from `node:path`; extend that import to include `join` rather than duplicating.)

Extend `SessionOverrides` (currently lines ~408–411):

```ts
export interface SessionOverrides {
  tools?: string[];
  thinkingLevel?: ThinkingLevel | string;
  /** Per-ticket egress opt-in; overrides cfg.sandbox.network for this session. */
  network?: boolean;
}
```

Add the exported helper (place it just above `makePiSessionFactory`):

```ts
export interface ResolveSandboxDeps {
  probe?: ExecProbe;
  makeScratch?: () => string;
  platform?: NodeJS.Platform;
  home?: string;
}

export interface ResolvedSandbox {
  backend: SandboxBackend;
  policy: SandboxPolicy;
}

/**
 * Decide sandbox backend + policy for a session, failing closed when a required
 * OS backend is unavailable. Returns null when sandboxing is disabled (the
 * factory then behaves exactly as before). Side effects (probe, scratch dir,
 * platform, home) are injectable so the decision is unit-testable.
 */
export async function resolveSandbox(
  cfg: Config,
  cwd: string,
  overrides: SessionOverrides | undefined,
  deps: ResolveSandboxDeps = {},
): Promise<ResolvedSandbox | null> {
  if (!cfg.sandbox.enabled) return null;
  const probe = deps.probe ?? defaultExecProbe;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const makeScratch = deps.makeScratch ?? (() => mkdtempSync(join(tmpdir(), "junco-sbx-")));

  const backend = selectBackend(cfg.sandbox.backend, platform);
  if (backend.name !== "none" && !(await backend.isAvailable(probe))) {
    throw new SandboxUnavailableError(
      `sandbox backend "${backend.name}" unavailable (binary missing or non-functional). ` +
        `Set [sandbox].enabled=false to opt out, or backend="none" to skip OS isolation.`,
    );
  }
  const network = overrides?.network ?? cfg.sandbox.network === "allow";
  const scratchDir = makeScratch();
  const policy = buildPolicy({
    cfg: cfg.sandbox,
    cwd,
    scratchDir,
    home,
    stateDir: cfg.stateDir,
    network,
  });
  return { backend, policy };
}
```

- [ ] **Step 4: Call it inside `makePiSessionFactory` and pass customTools/resourceLoader**

Inside the returned `async () => { ... }`, after the `model` is resolved and before `const { session } = await createAgentSession({...})`, insert:

```ts
    // Sandbox (opt-in): replace built-in tools with sandboxed operations and
    // freeze ambient extension loading. Inert when [sandbox].enabled is false.
    let sandboxTools: unknown[] | undefined;
    let sandboxLoader: unknown;
    const resolved = await resolveSandbox(cfg, cwd, overrides);
    if (resolved) {
      const { createToolDefinition } = await import(
        "@earendil-works/pi-coding-agent/dist/core/tools/index.js"
      );
      const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
      const built = buildSandbox(
        { createToolDefinition, DefaultResourceLoader },
        {
          cwd,
          toolNames: overrides?.tools ?? cfg.tools,
          backend: resolved.backend,
          policy: resolved.policy,
          home: homedir(),
        },
      );
      sandboxTools = built.customTools;
      sandboxLoader = built.resourceLoader;
    }
```

Then change the `createAgentSession({...})` call to spread the sandbox fields (add these two lines inside the object literal, after `sessionManager: SessionManager.inMemory(cwd),`):

```ts
      ...(sandboxTools ? { customTools: sandboxTools } : {}),
      ...(sandboxLoader ? { resourceLoader: sandboxLoader } : {}),
```

(If Task 9 found the deep import blocked, replace the `createToolDefinition` import line with the working path it recorded.)

- [ ] **Step 5: Run tests + typecheck + build**

Run: `npx vitest run tests/sessionSandboxWiring.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -15 /tmp/o`
Expected: PASS.
Run: `npm run typecheck > /tmp/tc 2>&1; echo "exit: $?"; tail -20 /tmp/tc`
Expected: exit 0.
Run: `npm run build > /tmp/b 2>&1; echo "exit: $?"; tail -10 /tmp/b`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/agent/session.ts tests/sessionSandboxWiring.test.ts
git commit -m "feat(sandbox): wire sandbox into makePiSessionFactory (fail-closed, opt-in)"
```

---

## Task 11: Per-ticket `network:` frontmatter + prFlow threading

**Files:**
- Modify: `src/ticketSchema.ts` (add `network` to the schema, additive)
- Modify: `src/types.ts` (add `network?: boolean` to the `Ticket` type)
- Modify: `src/ticket.ts` (parse `network`)
- Modify: `src/prFlow.ts` (pass `{ network: task.network }` at lines ~444 and ~640)
- Modify: `src/planPrompt.ts` (add `network` to the machine-owned frontmatter note)
- Create/Modify test: `tests/ticket.test.ts` (or the existing ticket-parsing test file)

**Interfaces:**
- Consumes: `SessionOverrides.network` from `session.ts` (Task 10).
- Produces: `Ticket.network?: boolean`.

- [ ] **Step 1: Write the failing test**

Add to the ticket-parsing test file (locate it: `ls tests | grep -i ticket`). Example additions:

```ts
import { parseTicket } from "../src/ticket.js"; // match the existing import in that file

it("parses network:true frontmatter as a boolean opt-in", () => {
  const md = `---\nid: t1\nrepo: /x\nnetwork: true\n---\nbody`;
  const t = parseTicket(md, "t1.md");
  expect(t.network).toBe(true);
});

it("defaults network to undefined when absent", () => {
  const md = `---\nid: t2\nrepo: /x\n---\nbody`;
  const t = parseTicket(md, "t2.md");
  expect(t.network).toBeUndefined();
});
```

(Match `parseTicket`'s real signature — check the top of the existing ticket test for the exact call shape and adapt.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ticket.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -20 /tmp/o`
Expected: FAIL — `t.network` is undefined even when set to true (not yet parsed).

- [ ] **Step 3: Implement parsing + schema + type**

In `src/ticketSchema.ts`, add an additive field near the `tools` field (mirror its optional shape):

```ts
  // Per-ticket egress opt-in for the sandbox (default false). Only widens this
  // one ticket; never a default. See [sandbox].network.
  network: { type: "boolean", required: false },
```

(Match the exact schema-entry format used by the neighboring `tools`/`timeout` entries in that file — copy their shape.)

In `src/types.ts`, add to the `Ticket` interface:

```ts
  /** Per-ticket sandbox egress opt-in (frontmatter `network: true`). */
  network?: boolean;
```

In `src/ticket.ts`, where frontmatter fields are read onto the ticket (near the `tools` parsing, ~line 73), add:

```ts
  const network = typeof fm.network === "boolean" ? fm.network : undefined;
```

and include `network` in the returned ticket object.

- [ ] **Step 4: Thread through prFlow**

In `src/prFlow.ts`, change the worker factory call (~line 444):

```ts
  const factory = (deps.sessionFactoryFor ?? makePiSessionFactory)(flowCfg, wtPath, {
    network: task.network,
  });
```

and the corrective factory call (~line 640):

```ts
        const correctiveFactory = (deps.sessionFactoryFor ?? makePiSessionFactory)(flowCfg, wtPath, {
          network: task.network,
        });
```

Add one line to `src/planPrompt.ts`'s machine-owned-frontmatter note so the planner is told it cannot set `network` (mirror how it already lists `repo:/workdir:/tools:`).

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/ticket.test.ts tests/prFlow.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -15 /tmp/o`
Expected: PASS.
Run: `npm run typecheck > /tmp/tc 2>&1; echo "exit: $?"; tail -15 /tmp/tc`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/ticketSchema.ts src/types.ts src/ticket.ts src/prFlow.ts src/planPrompt.ts tests/ticket.test.ts
git commit -m "feat(sandbox): per-ticket network: frontmatter opt-in"
```

---

## Task 12: Doctor preflight for the sandbox backend

**Files:**
- Modify: `src/doctor.ts` (add a numbered check inside the `if (cfg) { ... }` block)
- Modify: `tests/doctor.test.ts` (add coverage)

**Interfaces:**
- Consumes: `selectBackend` from `./agent/sandbox/backend.js`; `DoctorDeps.execFn`.

- [ ] **Step 1: Write the failing test**

Add to `tests/doctor.test.ts` (match the file's existing `runDoctor` harness + `deps` shape):

```ts
it("reports sandbox backend availability when enabled", async () => {
  const lines: string[] = [];
  const cfg = { ...baseCfg, sandbox: { ...baseCfg.sandbox, enabled: true, backend: "bwrap" } };
  await runDoctor("/cfg", {
    loadConfigFn: () => cfg,
    execFn: async (cmd) => ({ code: cmd === "bwrap" ? 0 : 127, stdout: "", stderr: "" }),
    printFn: (s) => lines.push(s),
    // ...whatever other deps the existing tests stub
  });
  expect(lines.join("")).toMatch(/sandbox/i);
});

it("does not report sandbox when disabled", async () => {
  const lines: string[] = [];
  await runDoctor("/cfg", {
    loadConfigFn: () => ({ ...baseCfg, sandbox: { ...baseCfg.sandbox, enabled: false } }),
    printFn: (s) => lines.push(s),
    // ...other deps
  });
  expect(lines.join("")).not.toMatch(/sandbox backend/i);
});
```

(Reuse the file's existing full-`Config` builder for `baseCfg`; if none exists, import the fixture pattern from Task 2.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/doctor.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -20 /tmp/o`
Expected: FAIL — no sandbox line printed.

- [ ] **Step 3: Implement the check**

Add an import at the top of `src/doctor.ts`:

```ts
import { selectBackend } from "./agent/sandbox/backend.js";
```

Inside `runDoctor`, within the `if (cfg) { ... }` block (after the git/gh checks, before the endpoint check), add:

```ts
    // 4a. sandbox backend (only when enabled)
    if (cfg.sandbox.enabled) {
      const backend = selectBackend(cfg.sandbox.backend, process.platform);
      if (backend.name === "none") {
        report(
          "warn",
          "sandbox",
          "enabled with backend=none — env scrub + fs jail only, no OS isolation",
        );
      } else {
        const ok = await backend.isAvailable((c, a) => execFn(c, a).then((r) => ({ code: r.code })));
        report(
          ok ? "ok" : "fail",
          "sandbox",
          ok
            ? `${backend.name} available`
            : `${backend.name} unavailable — tickets will fail closed (install it or set backend/none)`,
        );
      }
    }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/doctor.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -12 /tmp/o`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/doctor.ts tests/doctor.test.ts
git commit -m "feat(doctor): preflight sandbox backend availability"
```

---

## Task 13: Platform-gated integration tests (real enforcement)

**Files:**
- Create: `tests/sandbox.integration.test.ts`

**Interfaces:** Consumes the real backends + `makeSandboxedBashOperations`. These tests actually run `bash` under Seatbelt/bwrap and are skipped when the backend is unavailable, so unit CI stays green everywhere while macOS/Linux runners exercise real isolation.

- [ ] **Step 1: Write the integration test**

```ts
// tests/sandbox.integration.test.ts
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectBackend, defaultExecProbe } from "../src/agent/sandbox/backend.js";
import { buildPolicy } from "../src/agent/sandbox/policy.js";
import { makeSandboxedBashOperations } from "../src/agent/sandbox/bashOps.js";
import type { SandboxBackend } from "../src/agent/sandbox/backend.js";

const backend = selectBackend("auto", process.platform);
let available = false;
beforeAll(async () => {
  available = backend.name !== "none" && (await backend.isAvailable(defaultExecProbe));
});

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run a command under the sandbox and collect exit code + output. */
async function run(b: SandboxBackend, command: string, cwd: string, scratch: string, network = false) {
  const policy = buildPolicy({
    cfg: { enabled: true, backend: "auto", network: "deny", extraDenyRead: [], extraAllowWrite: [] },
    cwd,
    scratchDir: scratch,
    home: process.env.HOME ?? "/tmp",
    stateDir: join(scratch, "state"),
    network,
  });
  const ops = makeSandboxedBashOperations(b, policy, { env: () => ({ ...process.env, GH_TOKEN: "SECRET_TOKEN" }) });
  let out = "";
  const res = await ops.exec(command, cwd, { onData: (d) => (out += d.toString()) });
  return { code: res.exitCode, out };
}

describe.skipIf(!process.env.CI && process.platform === "win32")("sandbox integration", () => {
  it("write inside the worktree succeeds", async () => {
    if (!available) return;
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    const r = await run(backend, `echo ok > "${work}/inside.txt"`, work, scratch);
    expect(r.code).toBe(0);
    expect(existsSync(join(work, "inside.txt"))).toBe(true);
  });

  it("write outside the worktree fails", async () => {
    if (!available) return;
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    const outside = tmp("junco-it-out-");
    const r = await run(backend, `echo no > "${outside}/x.txt"`, work, scratch);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
  });

  it("the child env has no GH_TOKEN", async () => {
    if (!available) return;
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    const r = await run(backend, `echo "TOKEN=[${"$"}{GH_TOKEN:-absent}]"`, work, scratch);
    expect(r.out).toContain("TOKEN=[absent]");
  });

  it("network egress fails when denied", async () => {
    if (!available) return;
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    // Attempt a fast TCP connect; must fail under net isolation.
    const r = await run(
      backend,
      `bash -c 'exec 3<>/dev/tcp/1.1.1.1/80' 2>&1; echo "exit=$?"`,
      work,
      scratch,
      false,
    );
    expect(r.out).toMatch(/exit=[^0]/);
  });

  it("reading a denied secret path fails", async () => {
    if (!available) return;
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    // ~/.ssh is in the built-in deny list; reading it must fail.
    const r = await run(backend, `cat "${process.env.HOME}/.ssh/known_hosts" 2>&1; echo "exit=$?"`, work, scratch);
    expect(r.out).toMatch(/exit=[^0]/);
  });
});
```

Note: the network and secret-read assertions depend on OS enforcement; if a specific runner cannot enforce (e.g. bwrap without userns), the `available` guard skips the whole suite. Keep the guard — do not weaken the assertions to make them pass unsandboxed.

- [ ] **Step 2: Run locally (macOS dev box → Seatbelt)**

Run: `npx vitest run tests/sandbox.integration.test.ts > /tmp/o 2>&1; echo "exit: $?"; tail -25 /tmp/o`
Expected: PASS (on a Mac with `sandbox-exec`) or all-skipped (if unavailable). If a real isolation assertion FAILS (not skips), the profile/args are wrong — fix Task 5 before proceeding; a failing enforcement test is the whole point.

- [ ] **Step 3: Commit**

```bash
git add tests/sandbox.integration.test.ts
git commit -m "test(sandbox): platform-gated real-enforcement integration tests"
```

---

## Task 14: Documentation + dedicated-identity guidance + default decision

**Files:**
- Modify: `docs/configuration.md` (document `[sandbox]`)
- Modify: `docs/operations.md` (§ Security model — dedicated GitHub identity + sandbox)
- Modify: `ARCHITECTURE.md` (one line in the PR-flow/agent section noting the sandbox seam)
- Modify: `CHANGELOG.md` (Keep a Changelog entry under Unreleased)
- Modify: `CLAUDE.md` (one line if a new invariant belongs there — e.g. "sandbox policy is pure/SDK-free")

- [ ] **Step 1: Document `[sandbox]` in `docs/configuration.md`**

Add a section mirroring the existing `[verify]`/`[git]` doc style, covering every field, the `auto` backend mapping, the built-in read deny-list, the `network` default and per-ticket `network: true` opt-in, and the fail-closed behavior. State plainly: `enabled` defaults to **false**; set it true to turn the sandbox on.

- [ ] **Step 2: Document the dedicated GitHub identity + sandbox in `docs/operations.md`**

Under the Security model section, add: the sandbox confines agent tool execution (filesystem to the worktree, no ambient credentials, no network by default); recommend authenticating the daemon as a dedicated machine GitHub account with a fine-grained PAT scoped to only the repos junco may touch, so the agent plane (which never holds the token, thanks to the env scrub) cannot act as the operator. Note the two planes.

- [ ] **Step 3: CHANGELOG entry**

Add under `## [Unreleased]`:

```markdown
### Added
- Native OS execution sandbox for the agent (`[sandbox]`, Seatbelt/macOS,
  bubblewrap/Linux): confines tool writes to the worktree, denies network by
  default (per-ticket `network: true` opt-in), scrubs credentials from the
  agent's environment, and freezes ambient Pi extension loading. Disabled by
  default; enable with `[sandbox].enabled = true`. Fails closed when a required
  backend binary is unavailable. `junco doctor` preflights availability.
```

- [ ] **Step 4: Decide the default (leave false; document how to enable)**

Confirm `[sandbox].enabled` defaults to `false` in `src/config.ts` (Task 2). This keeps the maintainer's live daemon unchanged on upgrade; they opt in by setting `enabled = true` after validating their repos build under it. Add a one-line pointer in the CHANGELOG entry (done in Step 3). Do **not** flip the default in this plan — that is a separate, maintainer-owned decision.

- [ ] **Step 5: Run the full gate**

Run:
```bash
npm run lint > /tmp/l 2>&1; echo "lint: $?"
npm run format:check > /tmp/f 2>&1; echo "fmt: $?"
npm run typecheck > /tmp/tc 2>&1; echo "tc: $?"
npm run build > /tmp/b 2>&1; echo "build: $?"
npx vitest run > /tmp/t 2>&1; echo "test: $?"; tail -6 /tmp/t
```
Expected: all exit 0; test tally shows the new suites passing and no regressions.

- [ ] **Step 6: Commit**

```bash
git add docs/configuration.md docs/operations.md ARCHITECTURE.md CHANGELOG.md CLAUDE.md
git commit -m "docs(sandbox): document [sandbox], dedicated identity, and defaults"
```

---

## Task 15: Final integration sweep + branch finish

**Files:** none (verification + housekeeping)

- [ ] **Step 1: Merge latest main (fast-moving repo)**

```bash
git fetch origin
git merge --no-edit origin/main
```
Resolve any conflicts (most likely in the six `Config` fixtures or `session.ts`); re-run the gate after.

- [ ] **Step 2: Run the full gate one more time**

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build && npx vitest run > /tmp/t 2>&1; echo "test: $?"; tail -8 /tmp/t
```
Expected: green.

- [ ] **Step 3: Sanity-run doctor in a sandbox (offline, disabled by default)**

```bash
SB=$(mktemp -d) && cd "$SB" && HOME="$SB" XDG_CONFIG_HOME="$SB/.config" \
  node /Users/alxedelweiss/junco/.claude/worktrees/worktree-2/dist/cli.js init --yes \
  && node /Users/alxedelweiss/junco/.claude/worktrees/worktree-2/dist/cli.js doctor ; \
  cd / && rm -rf "$SB"
```
Expected: doctor runs; with sandbox disabled, no sandbox line (or an informational one). Enable `[sandbox].enabled=true` + `backend=seatbelt` in the sandbox config and re-run to see the availability check.

- [ ] **Step 4: Strip any AI attribution and finish the branch**

```bash
git log --format='%an <%ae>%n%b' origin/main..HEAD | grep -i "co-authored-by: claude" && echo "STRIP NEEDED" || echo "clean"
```
If any trailer is present, rebase/amend it away. Then use superpowers:finishing-a-development-branch to choose merge/PR.

---

## Self-Review Notes (completed during authoring)

- **Spec coverage:** Phase 0 (env scrub → Task 1; noExtensions → Task 10; dedicated identity → Task 14). Phase 1 (config → Task 2; policy → Task 3; path-jail → Task 4; backends → Task 5; bash ops → Task 6; fs jail → Task 7; glue → Task 8; wiring + fail-closed → Task 10; network opt-in → Task 11; doctor → Task 12; integration → Task 13; docs → Task 14). Phase 2 explicitly out of scope (seam left via `SandboxBackend`).
- **Type consistency:** `SandboxPolicy`, `SandboxBackend`, `BashOperationsLike`, `SdkToolFactories`, `resolveSandbox`/`ResolvedSandbox` names are used identically across tasks. `buildPolicy` input keys (`cfg,cwd,scratchDir,home,stateDir,network`) match every call site (Tasks 3, 10, 13). `toolsOptionsFor` signature matches its use in `buildSandbox`.
- **Open decision surfaced, not hidden:** `[sandbox].enabled` default is `false` (Task 2/14) to protect the live runtime; flipping it is left to the maintainer.
- **Known runtime risk pinned:** the SDK deep-import path is verified by a probe (Task 9) before it is depended on (Task 10), with a documented fallback.
