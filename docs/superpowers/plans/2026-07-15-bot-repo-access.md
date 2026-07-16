# Bot Repo Access (Classify + Grant + Auto-Onboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unwatched-repo dispatch becomes permission-aware (direct/fork/blocked with auto-onboard), and getting the bot write access to a repo collapses to one automated invite-as-you/accept-as-bot step.

**Architecture:** New `src/botAccess.ts` owns classification (`classifyRepoAccess`) and the two-identity grant (`grantBotAccess`), both riding the existing `gh()` wrapper (identity = whether the cfg passed in carries `ghAuth`). `resolveIssueTarget` swaps its watchlist-only fork decision for classification; `authCmd` gains a `grant` verb; the dashboard add-repo flow, doctor, and wizard flight check get thin wiring. Spec: `docs/superpowers/specs/2026-07-15-bot-repo-access-design.md`.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), vitest, no new dependencies. Branch `feat/bot-repo-access`, stacked on `feat/gh-bot-account` (PR #186).

## Global Constraints

- No AI attribution in commits, ever (verify `git log -1 --format=%B` after each commit; amend trailers away).
- Conventional commits; suite green at every commit; prettier on touched files pre-commit; typecheck via `npx tsc --noEmit -p tsconfig.eslint.json` must add no NEW errors (~57 pre-existing are noise).
- Exit-code trap: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — never pipe vitest through a filter.
- The fork path for public unowned repos must remain byte-for-byte unchanged (open-source contribution is a hard requirement).
- Granting fires only from human-triggered surfaces (CLI, dashboard add-repo, doctor's printed command); the daemon never grants.
- User-visible text stays stack-agnostic.
- Blocked-error copy (exact): private without access → `no access to <nwo> (private) — run: junco auth grant <nwo>` ; SSO → `the bot's token is blocked by SAML enforcement for <nwo> — authorize gh for the org in the bot's browser session, then retry` . When the active cfg has NO `ghAuth` (ambient mode), the private message is `you don't have push access to <nwo> (private)` — never recommend `junco auth grant` when bot mode is off.

---

### Task 1: `src/botAccess.ts` — `classifyRepoAccess`

**Files:**

- Create: `src/botAccess.ts`
- Test: `tests/botAccess.test.ts` (create)

**Interfaces:**

- Consumes: `gh` + `GitCallOpts` from `src/git.ts`; `Config`, `GhAuthContext` from `src/types.ts`; `withBotAuth` from `src/ghAuth.ts` (Task 2 uses it; import in Task 2).
- Produces (later tasks call these exact names):
  - `export type RepoAccess = { mode: "direct" } | { mode: "fork" } | { mode: "blocked"; reason: "no-access" | "sso" };`
  - `export interface BotAccessDeps { ghFn?: typeof gh; withBotAuthFn?: (cfg: Config) => Promise<Config>; retryDelayMs?: number; sleepFn?: (ms: number) => Promise<void>; }`
  - `export async function classifyRepoAccess(cfg: Config, nwo: string, deps?: BotAccessDeps): Promise<RepoAccess>` — identity is whatever `cfg` carries (bot when `ghAuth` attached, ambient otherwise).
  - `export const SAML_MARKER = "SAML enforcement";`

- [ ] **Step 1: Write the failing tests**

Create `tests/botAccess.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyRepoAccess } from "../src/botAccess.js";
import type { Config, GhAuthContext } from "../src/types.js";
import type { CmdResult, GitCallOpts } from "../src/git.js";

const CTX: GhAuthContext = {
  configDir: "/sbx/junco-gh",
  login: "junco-agent",
  email: "1+junco-agent@users.noreply.github.com",
  credentialHelper: "!gh auth git-credential",
};

// Minimal cfg — botAccess only reads ghBin/ghAuth via the gh() seam.
const CFG = { ghBin: "gh", ghAuth: CTX } as unknown as Config;

/** Fake gh() that records the cfg identity it was called with and scripts
 * responses per args-key. Discriminating on cfg.ghAuth presence pins identity
 * selection at this layer (gh()'s env injection is pinned by tests/git.test.ts). */
function fakeGh(script: Record<string, Partial<CmdResult>>) {
  const calls: Array<{ hadAuth: boolean; args: string[] }> = [];
  const ghFn = async (
    cfg: { ghBin: string; ghAuth?: GhAuthContext },
    args: string[],
    _opts?: GitCallOpts,
  ): Promise<CmdResult> => {
    calls.push({ hadAuth: cfg.ghAuth !== undefined, args });
    const hit = script[args.join(" ")] ?? { code: 1, stdout: "", stderr: "HTTP 404" };
    return { code: hit.code ?? 0, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
  };
  return { ghFn: ghFn as never, calls };
}

const VIEW = "repo view acme/api --json viewerPermission,isPrivate";

describe("classifyRepoAccess", () => {
  it.each(["ADMIN", "MAINTAIN", "WRITE"])("%s → direct", async (level) => {
    const { ghFn, calls } = fakeGh({
      [VIEW]: { code: 0, stdout: JSON.stringify({ viewerPermission: level, isPrivate: true }) },
    });
    expect(await classifyRepoAccess(CFG, "acme/api", { ghFn })).toEqual({ mode: "direct" });
    expect(calls[0].hadAuth).toBe(true); // ran under the identity cfg carries
  });

  it("public without push → fork", async () => {
    const { ghFn } = fakeGh({
      [VIEW]: { code: 0, stdout: JSON.stringify({ viewerPermission: "READ", isPrivate: false }) },
    });
    expect(await classifyRepoAccess(CFG, "acme/api", { ghFn })).toEqual({ mode: "fork" });
  });

  it("private without push → blocked/no-access", async () => {
    const { ghFn } = fakeGh({
      [VIEW]: { code: 0, stdout: JSON.stringify({ viewerPermission: "READ", isPrivate: true }) },
    });
    expect(await classifyRepoAccess(CFG, "acme/api", { ghFn })).toEqual({
      mode: "blocked",
      reason: "no-access",
    });
  });

  it("404 (invisible private repo) → blocked/no-access", async () => {
    const { ghFn } = fakeGh({
      [VIEW]: { code: 1, stderr: "GraphQL: Could not resolve to a Repository (HTTP 404)" },
    });
    expect(await classifyRepoAccess(CFG, "acme/api", { ghFn })).toEqual({
      mode: "blocked",
      reason: "no-access",
    });
  });

  it("SAML-enforcement 403 → blocked/sso", async () => {
    const { ghFn } = fakeGh({
      [VIEW]: {
        code: 1,
        stderr: "HTTP 403: Resource protected by organization SAML enforcement",
      },
    });
    expect(await classifyRepoAccess(CFG, "acme/api", { ghFn })).toEqual({
      mode: "blocked",
      reason: "sso",
    });
  });

  it("null viewerPermission on a public repo → fork", async () => {
    const { ghFn } = fakeGh({
      [VIEW]: { code: 0, stdout: JSON.stringify({ viewerPermission: null, isPrivate: false }) },
    });
    expect(await classifyRepoAccess(CFG, "acme/api", { ghFn })).toEqual({ mode: "fork" });
  });

  it("unparseable stdout → blocked/no-access", async () => {
    const { ghFn } = fakeGh({ [VIEW]: { code: 0, stdout: "not json" } });
    expect(await classifyRepoAccess(CFG, "acme/api", { ghFn })).toEqual({
      mode: "blocked",
      reason: "no-access",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/botAccess.test.ts > /tmp/ba1.out 2>&1; echo "exit: $?"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/botAccess.ts`:

```ts
/**
 * Repo access classification + bot grant (spec
 * docs/superpowers/specs/2026-07-15-bot-repo-access-design.md).
 *
 * classifyRepoAccess decides which PR flow an unwatched repo takes under the
 * identity the given cfg carries (bot when `ghAuth` is attached, ambient
 * otherwise): push access → direct branches; public without push → fork mode;
 * private without push → blocked (grant or SSO guidance). A 404 is treated as
 * private-and-invisible: callers reach classification only after an AMBIENT
 * read of the repo succeeded, and GitHub deliberately 404s private repos to
 * non-members.
 */

import type { Config } from "./types.js";
import { gh } from "./git.js";

export type RepoAccess =
  | { mode: "direct" }
  | { mode: "fork" }
  | { mode: "blocked"; reason: "no-access" | "sso" };

export interface BotAccessDeps {
  ghFn?: typeof gh;
  withBotAuthFn?: (cfg: Config) => Promise<Config>;
  /** Backoff between invitation-accept retries (tests pass ~1ms). */
  retryDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

/** Substring gh surfaces when a token lacks SSO authorization for an org. */
export const SAML_MARKER = "SAML enforcement";

const PUSH_LEVELS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);
const GH_TIMEOUT = 30_000;

export async function classifyRepoAccess(
  cfg: Config,
  nwo: string,
  deps: BotAccessDeps = {},
): Promise<RepoAccess> {
  const ghFn = deps.ghFn ?? gh;
  const r = await ghFn(cfg, ["repo", "view", nwo, "--json", "viewerPermission,isPrivate"], {
    check: false,
    timeoutMs: GH_TIMEOUT,
    retryNetwork: true,
  });
  if (r.code !== 0) {
    if (r.stderr.includes(SAML_MARKER)) return { mode: "blocked", reason: "sso" };
    return { mode: "blocked", reason: "no-access" };
  }
  let parsed: { viewerPermission: string | null; isPrivate: boolean };
  try {
    parsed = JSON.parse(r.stdout) as typeof parsed;
  } catch {
    return { mode: "blocked", reason: "no-access" };
  }
  if (parsed.viewerPermission !== null && PUSH_LEVELS.has(parsed.viewerPermission)) {
    return { mode: "direct" };
  }
  return parsed.isPrivate ? { mode: "blocked", reason: "no-access" } : { mode: "fork" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/botAccess.test.ts > /tmp/ba1.out 2>&1; echo "exit: $?"` — PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/botAccess.ts tests/botAccess.test.ts
git add -A && git commit -m "feat(botAccess): classifyRepoAccess — direct/fork/blocked under the active identity"
```

---

### Task 2: `grantBotAccess` — invite as you, accept as the bot

**Files:**

- Modify: `src/botAccess.ts`
- Test: `tests/botAccess.test.ts`

**Interfaces:**

- Consumes: `withBotAuth` from `src/ghAuth.ts` (throws with an actionable message when `botAccount.enabled` but unauthed); Task 1's `BotAccessDeps`, `SAML_MARKER`, `classifyRepoAccess`.
- Produces: `export async function grantBotAccess(cfg: Config, nwo: string, deps?: BotAccessDeps): Promise<{ login: string }>` — `cfg` is the AMBIENT config (grant attaches the bot context internally for the accept/verify steps). Throws `Error` with mapped messages on every failure path. Idempotent (204 = already collaborator → verify only).

- [ ] **Step 1: Write the failing tests**

Append to `tests/botAccess.test.ts` (extend `fakeGh` so a script value may be a FUNCTION of the recorded call, letting one args-key answer differently per identity):

```ts
import { grantBotAccess } from "../src/botAccess.js";

type Responder =
  | Partial<CmdResult>
  | ((call: { hadAuth: boolean; args: string[] }) => Partial<CmdResult>);

function fakeGh2(script: Record<string, Responder>) {
  const calls: Array<{ hadAuth: boolean; args: string[] }> = [];
  const ghFn = async (
    cfg: { ghBin: string; ghAuth?: GhAuthContext },
    args: string[],
  ): Promise<CmdResult> => {
    const call = { hadAuth: cfg.ghAuth !== undefined, args };
    calls.push(call);
    const raw = script[args.join(" ")] ?? { code: 1, stdout: "", stderr: "HTTP 404" };
    const hit = typeof raw === "function" ? raw(call) : raw;
    return { code: hit.code ?? 0, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
  };
  return { ghFn: ghFn as never, calls };
}

const AMBIENT_CFG = {
  ghBin: "gh",
  botAccount: { enabled: true, configDir: "/sbx/junco-gh" },
} as unknown as Config;
const withBotAuthFn = async (c: Config) => ({ ...c, ghAuth: CTX });

const PUT = "api repos/acme/api/collaborators/junco-agent -X PUT -f permission=push";
const LIST = "api /user/repository_invitations";
const ACCEPT = "api /user/repository_invitations/77 -X PATCH";
const VIEW_KEY = "repo view acme/api --json viewerPermission,isPrivate";

describe("grantBotAccess", () => {
  it("201 invite → accepted as the bot → verified", async () => {
    const { ghFn, calls } = fakeGh2({
      [PUT]: { code: 0, stdout: JSON.stringify({ id: 77 }) }, // 201: body on stdout
      [LIST]: {
        code: 0,
        stdout: JSON.stringify([{ id: 77, repository: { full_name: "acme/api" } }]),
      },
      [ACCEPT]: { code: 0, stdout: "" },
      [VIEW_KEY]: {
        code: 0,
        stdout: JSON.stringify({ viewerPermission: "WRITE", isPrivate: true }),
      },
    });
    const r = await grantBotAccess(AMBIENT_CFG, "acme/api", { ghFn, withBotAuthFn });
    expect(r).toEqual({ login: "junco-agent" });
    // Identity pinning: the invite ran ambient; list/accept/verify ran as bot.
    const byKey = Object.fromEntries(calls.map((c) => [c.args.join(" "), c.hadAuth]));
    expect(byKey[PUT]).toBe(false);
    expect(byKey[LIST]).toBe(true);
    expect(byKey[ACCEPT]).toBe(true);
    expect(byKey[VIEW_KEY]).toBe(true);
  });

  it("204 already-collaborator (empty stdout) → skips accept, verifies", async () => {
    const { ghFn, calls } = fakeGh2({
      [PUT]: { code: 0, stdout: "" }, // 204: no body
      [VIEW_KEY]: {
        code: 0,
        stdout: JSON.stringify({ viewerPermission: "WRITE", isPrivate: true }),
      },
    });
    await grantBotAccess(AMBIENT_CFG, "acme/api", { ghFn, withBotAuthFn });
    expect(calls.some((c) => c.args.join(" ") === LIST)).toBe(false);
  });

  it("invitation not visible on first list → bounded retry then success", async () => {
    let listCount = 0;
    const { ghFn } = fakeGh2({
      [PUT]: { code: 0, stdout: JSON.stringify({ id: 77 }) },
      [LIST]: () => {
        listCount += 1;
        return listCount < 2
          ? { code: 0, stdout: "[]" }
          : {
              code: 0,
              stdout: JSON.stringify([{ id: 77, repository: { full_name: "acme/api" } }]),
            };
      },
      [ACCEPT]: { code: 0 },
      [VIEW_KEY]: {
        code: 0,
        stdout: JSON.stringify({ viewerPermission: "WRITE", isPrivate: true }),
      },
    });
    await grantBotAccess(AMBIENT_CFG, "acme/api", {
      ghFn,
      withBotAuthFn,
      retryDelayMs: 1,
      sleepFn: async () => {},
    });
    expect(listCount).toBe(2);
  });

  it("403 without admin → actionable error, no accept attempted", async () => {
    const { ghFn, calls } = fakeGh2({
      [PUT]: { code: 1, stderr: "HTTP 403: Must have admin rights" },
    });
    await expect(grantBotAccess(AMBIENT_CFG, "acme/api", { ghFn, withBotAuthFn })).rejects.toThrow(
      /admin/,
    );
    expect(calls.some((c) => c.args.join(" ") === LIST)).toBe(false);
  });

  it("SAML 403 → SSO guidance", async () => {
    const { ghFn } = fakeGh2({
      [PUT]: { code: 1, stderr: "HTTP 403: Resource protected by organization SAML enforcement" },
    });
    await expect(grantBotAccess(AMBIENT_CFG, "acme/api", { ghFn, withBotAuthFn })).rejects.toThrow(
      /SAML/,
    );
  });

  it("botAccount disabled → refuses with junco auth login pointer", async () => {
    const off = { ...AMBIENT_CFG, botAccount: { enabled: false, configDir: "/x" } } as Config;
    await expect(grantBotAccess(off, "acme/api", { ghFn: fakeGh2({}).ghFn })).rejects.toThrow(
      /junco auth login/,
    );
  });

  it("accept never succeeds → error names manual acceptance and the bot login", async () => {
    const { ghFn } = fakeGh2({
      [PUT]: { code: 0, stdout: JSON.stringify({ id: 77 }) },
      [LIST]: { code: 0, stdout: "[]" },
    });
    await expect(
      grantBotAccess(AMBIENT_CFG, "acme/api", {
        ghFn,
        withBotAuthFn,
        retryDelayMs: 1,
        sleepFn: async () => {},
      }),
    ).rejects.toThrow(/junco-agent/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/botAccess.test.ts > /tmp/ba2.out 2>&1; echo "exit: $?"`
Expected: FAIL — `grantBotAccess` not exported.

- [ ] **Step 3: Implement**

Append to `src/botAccess.ts` (add `import { withBotAuth } from "./ghAuth.js";` and a `firstLine` helper):

```ts
const firstLine = (s: string): string => (s.split("\n")[0] ?? "").slice(0, 200);

const ssoMessage = (nwo: string): string =>
  `the bot's token is blocked by SAML enforcement for ${nwo} — authorize gh for the org in the bot's browser session, then retry`;

/**
 * Grant the bot write access to `nwo` using both identities junco holds:
 * invite as the operator (ambient cfg — needs admin on the repo), accept as
 * the bot (GH_CONFIG_DIR via the attached context), then verify. Idempotent:
 * an already-collaborator invite (HTTP 204, empty body) skips straight to
 * verification. Human-triggered surfaces only — the daemon never calls this.
 */
export async function grantBotAccess(
  cfg: Config,
  nwo: string,
  deps: BotAccessDeps = {},
): Promise<{ login: string }> {
  const ghFn = deps.ghFn ?? gh;
  const sleep = deps.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retryDelayMs = deps.retryDelayMs ?? 1500;

  if (!cfg.botAccount.enabled) {
    throw new Error("junco auth grant needs botAccount.enabled — run: junco auth login first");
  }
  const botCfg = await (deps.withBotAuthFn ?? ((c: Config) => withBotAuth(c)))(cfg);
  // withBotAuth throws when enabled-but-unauthed, so ghAuth is present here.
  const login = botCfg.ghAuth!.login;

  // 1. Invite as the operator. gh api prints the response body: HTTP 201
  //    (invitation created) has a JSON body; HTTP 204 (already a collaborator)
  //    has none — empty stdout is the idempotent-success discriminator.
  const invite = await ghFn(
    cfg,
    ["api", `repos/${nwo}/collaborators/${login}`, "-X", "PUT", "-f", "permission=push"],
    { check: false, timeoutMs: GH_TIMEOUT, retryNetwork: true },
  );
  if (invite.code !== 0) {
    if (invite.stderr.includes(SAML_MARKER)) throw new Error(ssoMessage(nwo));
    if (invite.stderr.includes("HTTP 403")) {
      throw new Error(
        `granting on ${nwo} needs admin — ask an org admin, or org policy forbids outside ` +
          `collaborators (${firstLine(invite.stderr)})`,
      );
    }
    throw new Error(`invite failed for ${nwo}: ${firstLine(invite.stderr)}`);
  }

  // 2. Accept as the bot (invitation propagation can lag — bounded retry).
  if (invite.stdout.trim() !== "") {
    let accepted = false;
    for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
      if (attempt > 0) await sleep(retryDelayMs);
      // No --paginate: multi-page output is concatenated JSON arrays (unparseable),
      // and a fresh invitation list is far below one page anyway.
      const list = await ghFn(botCfg, ["api", "/user/repository_invitations"], {
        check: false,
        timeoutMs: GH_TIMEOUT,
        retryNetwork: true,
      });
      if (list.code !== 0) continue;
      let invitations: Array<{ id: number; repository: { full_name: string } }>;
      try {
        invitations = JSON.parse(list.stdout) as typeof invitations;
      } catch {
        continue;
      }
      const match = invitations.find(
        (i) => i.repository.full_name.toLowerCase() === nwo.toLowerCase(),
      );
      if (!match) continue;
      const accept = await ghFn(
        botCfg,
        ["api", `/user/repository_invitations/${match.id}`, "-X", "PATCH"],
        {
          check: false,
          timeoutMs: GH_TIMEOUT,
          retryNetwork: true,
        },
      );
      accepted = accept.code === 0;
    }
    if (!accepted) {
      throw new Error(
        `invitation for ${nwo} was created but could not be accepted — accept it manually as ` +
          `${login}, or re-run: junco auth grant ${nwo}`,
      );
    }
  }

  // 3. Verify as the bot.
  const access = await classifyRepoAccess(botCfg, nwo, deps);
  if (access.mode !== "direct") {
    throw new Error(
      `grant did not take effect on ${nwo} (bot access: ${access.mode}) — re-run: junco auth grant ${nwo}`,
    );
  }
  return { login };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/botAccess.test.ts > /tmp/ba2.out 2>&1; echo "exit: $?"` — PASS. Then the full suite — PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/botAccess.ts tests/botAccess.test.ts
git add -A && git commit -m "feat(botAccess): grantBotAccess — invite as operator, accept as bot, verify"
```

---

### Task 3: Permission-aware dispatch + auto-onboard in `resolveIssueTarget`

**Files:**

- Modify: `src/externalDispatch.ts` (`ExternalDispatchDeps` ~:17; the unowned branch of `resolveIssueTarget` ~:131-149)
- Test: `tests/externalDispatch.test.ts`

**Interfaces:**

- Consumes: `classifyRepoAccess`, `RepoAccess`, `BotAccessDeps` (Tasks 1-2).
- Produces: `ExternalDispatchDeps` gains `classifyFn?: typeof classifyRepoAccess`. Behavior later tasks and docs rely on: unwatched + `direct` → `ensureCloneFn(botCfg, nwo, deps, { fork: false })`, watchlist entry `{ nwo, path, external: false }`, `IssueTarget.external === false`, `forkNwo === null`; unwatched + `fork` → today's behavior byte-for-byte (`{ fork: opts.fork ?? true }`, watchlist `external: true`, `external === true`); `blocked` → throw with the Global Constraints copy (grant hint ONLY when `botCfg.ghAuth` present). `opts.fork === false` (assess) still forces a fork-less clone in ALL non-blocked modes with `external` recorded per classification.

- [ ] **Step 1: Write the failing tests**

In `tests/externalDispatch.test.ts` (reuse the file's existing fixture helpers — the issue-view `ghFn` fake, `FAKE_CTX`, cfg builders; read the file first):

```ts
// New describe block. classifyFn is injected per-case; ensureCloneFn records
// its cfg + opts; the watchlist file is read back to assert onboarding.

it("unwatched + direct → fork-less clone, watchlist external:false, non-external target", async () => {
  const cloneCalls: Array<{ hadAuth: boolean; fork: boolean | undefined }> = [];
  const deps = {
    ghFn: fakeIssueViewGh, // existing fake
    withBotAuthFn: async (c: Config) => ({ ...c, ghAuth: FAKE_CTX }),
    classifyFn: async () => ({ mode: "direct" as const }),
    ensureCloneFn: async (c: Config, _n: string, _d: unknown, o?: { fork?: boolean }) => {
      cloneCalls.push({ hadAuth: c.ghAuth !== undefined, fork: o?.fork });
      return { path: "/clones/acme/api", forkNwo: null };
    },
  };
  const t = await resolveIssueTarget(cfg, "acme/api#1", deps);
  expect(cloneCalls[0]).toEqual({ hadAuth: true, fork: false });
  expect(t.external).toBe(false);
  expect(t.forkNwo).toBeNull();
  const wl = readWatchlist(watchlistPath(cfg));
  expect(wl.entries.find((e) => e.nwo === "acme/api")?.external).toBe(false);
});

it("unwatched + fork → today's fork path unchanged", async () => {
  // classifyFn → { mode: "fork" }; ensureCloneFn returns forkNwo "junco-agent/api";
  // assert opts.fork === true (defaulted), external === true, watchlist external:true.
});

it("unwatched + blocked/no-access with bot auth → throws naming junco auth grant", async () => {
  // classifyFn → { mode: "blocked", reason: "no-access" }; ensureCloneFn must NOT be called;
  // expect rejects.toThrow(/junco auth grant acme\/api/).
});

it("unwatched + blocked in ambient mode → throws WITHOUT the grant hint", async () => {
  // withBotAuthFn: async (c) => c  (no ghAuth attached — bot mode off);
  // expect rejects.toThrow(/push access/) and the message NOT to contain "auth grant".
});

it("unwatched + blocked/sso → SSO guidance", async () => {
  // classifyFn → { mode: "blocked", reason: "sso" }; expect /SAML/.
});

it("assess override: opts.fork=false + fork classification → clone-only, external:true", async () => {
  // resolveIssueTarget(cfg, ref, deps, { fork: false }); assert ensureCloneFn got fork:false
  // and the watchlist entry is external:true.
});
```

(Write these as REAL tests against the file's actual fixtures — the sketch names the assertions; the surrounding scaffolding comes from the file's existing tests. Also update any EXISTING test in this file that asserts the old unconditional-fork behavior: those must now inject `classifyFn: async () => ({ mode: "fork" as const })` to keep their premise.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/externalDispatch.test.ts > /tmp/ed.out 2>&1; echo "exit: $?"`
Expected: FAIL — `classifyFn` unknown / fork:false never passed.

- [ ] **Step 3: Implement**

In `src/externalDispatch.ts`: add `import { classifyRepoAccess } from "./botAccess.js";`; `ExternalDispatchDeps` gains `classifyFn?: typeof classifyRepoAccess;`. Replace the unowned branch body:

```ts
let clonePath: string;
let forkNwo: string | null = null;
let external = false;
if (owned !== undefined) {
  clonePath = owned.path;
} else {
  // Provisioning acts as the BOT (spec: boundary exception — anything this
  // creates is the daemon's future push target). Classification decides the
  // flow: push access → direct branches (fork-less clone, auto-onboarded as
  // a first-class watched repo — the bridge will sweep it); public without
  // push → fork-PR mode (the open-source path, unchanged); private without
  // push → fail loud with the fix.
  const botCfg = await withBotAuthFn(cfg);
  const access = await (deps.classifyFn ?? classifyRepoAccess)(botCfg, ref.nwo, deps);
  if (access.mode === "blocked") {
    if (access.reason === "sso") {
      throw new Error(
        `the bot's token is blocked by SAML enforcement for ${ref.nwo} — authorize gh for ` +
          `the org in the bot's browser session, then retry`,
      );
    }
    throw new Error(
      botCfg.ghAuth !== undefined
        ? `no access to ${ref.nwo} (private) — run: junco auth grant ${ref.nwo}`
        : `you don't have push access to ${ref.nwo} (private)`,
    );
  }
  external = access.mode === "fork";
  const wantFork = (opts.fork ?? true) && external;
  const provisioned = await ensureCloneFn(botCfg, ref.nwo, deps, { fork: wantFork });
  clonePath = provisioned.path;
  forkNwo = provisioned.forkNwo;
  const file = watchlistPath(cfg);
  const { entries } = readWatchlist(file);
  if (!entries.some((e) => e.nwo.toLowerCase() === ref.nwo.toLowerCase())) {
    writeWatchlist(file, [...entries, { nwo: ref.nwo, path: clonePath, external }]);
  }
}
```

(The existing `const external = owned === undefined;` line is deleted — `external` is now the `let` above; the return statement is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/externalDispatch.test.ts tests/analyzeCmd.test.ts tests/assessCmd.test.ts tests/dispatch.test.ts > /tmp/ed.out 2>&1; echo "exit: $?"` — PASS (the analyze/assess/dispatch suites consume resolveIssueTarget; fix any that assumed unconditional forking by injecting `classifyFn`). Then the full suite — PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/externalDispatch.ts tests/externalDispatch.test.ts
git add -A && git commit -m "feat(dispatch): permission-aware external repos — direct auto-onboard, fork, or blocked"
```

---

### Task 4: `junco auth grant <owner/repo>` verb

**Files:**

- Modify: `src/authCmd.ts` (verb dispatch at the `args[0] !== "login"` guard; USAGE const)
- Modify: `src/cli.ts` (USAGE auth line only — dispatch block already routes all `auth` verbs)
- Test: `tests/authCmd.test.ts`

**Interfaces:**

- Consumes: `grantBotAccess` (Task 2); `loadConfig` from `src/config.js`.
- Produces: `AuthCmdDeps` gains `grantFn?: typeof grantBotAccess; loadConfigFn?: (p: string) => Config;`. `runAuthCommand(["grant", nwo], configPath, deps)` → 0 with `✓ <login> has write on <nwo>`; 2 on missing/malformed nwo; 1 on missing config or grant failure (message passthrough).

- [ ] **Step 1: Write the failing tests**

Append to `tests/authCmd.test.ts` (reuse its `writeConfig`/tmp-dir helpers):

```ts
describe("junco auth grant", () => {
  it("grants and prints the identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    const configPath = writeConfig(dir, { vaultRoot: "/tmp/v", botAccount: { enabled: true } });
    const out: string[] = [];
    const code = await runAuthCommand(["grant", "acme/api"], configPath, {
      grantFn: async () => ({ login: "junco-agent" }),
      printFn: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("junco-agent has write on acme/api");
  });

  it("malformed or missing nwo → usage, exit 2", async () => {
    expect(await runAuthCommand(["grant"], "/nonexistent", { printErrFn: () => {} })).toBe(2);
    expect(
      await runAuthCommand(["grant", "not-a-repo"], "/nonexistent", { printErrFn: () => {} }),
    ).toBe(2);
  });

  it("grant failure → exit 1 with the mapped message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    const configPath = writeConfig(dir, { vaultRoot: "/tmp/v", botAccount: { enabled: true } });
    const errs: string[] = [];
    const code = await runAuthCommand(["grant", "acme/api"], configPath, {
      grantFn: async () => {
        throw new Error("granting on acme/api needs admin — ask an org admin");
      },
      printErrFn: (s) => errs.push(s),
    });
    expect(code).toBe(1);
    expect(errs.join("")).toContain("needs admin");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/authCmd.test.ts > /tmp/ac.out 2>&1; echo "exit: $?"`
Expected: FAIL — grant verb prints login-usage and returns 2.

- [ ] **Step 3: Implement**

In `src/authCmd.ts`: update `USAGE` to `"Usage: junco auth login | junco auth grant <owner/repo>   (see docs/bot-account.md)\n"`; change the guard to `if (args[0] !== "login" && args[0] !== "grant")`; add before the login flow:

```ts
if (args[0] === "grant") {
  const nwo = args[1];
  if (!nwo || !/^[\w.-]+\/[\w.-]+$/.test(nwo)) {
    printErr(USAGE);
    return 2;
  }
  if (!existsFn(resolved)) {
    printErr(`no config at ${resolved} — run \`junco dashboard\` or \`junco config init\` first\n`);
    return 1;
  }
  // grant needs the assembled Config (botAccount defaults, ghBin, expandHome).
  let cfg: Config;
  try {
    cfg = (deps.loadConfigFn ?? loadConfig)(resolved);
  } catch (e) {
    printErr(`config unreadable: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  try {
    const { login } = await (deps.grantFn ?? grantBotAccess)(cfg, nwo);
    print(`✓ ${login} has write on ${nwo}\n`);
    return 0;
  } catch (e) {
    printErr(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
```

(Imports: `loadConfig` from `./config.js`, `grantBotAccess` from `./botAccess.js`, `type Config` from `./types.js`. The `resolved`/`existsFn` consts move above the verb branches so both share them.) In `src/cli.ts`, the USAGE auth line becomes: `  auth login | auth grant <owner/repo>   Bot-account login / grant the bot write access to a repo`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/authCmd.test.ts tests/cli.test.ts > /tmp/ac.out 2>&1; echo "exit: $?"` — PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/authCmd.ts src/cli.ts tests/authCmd.test.ts
git add -A && git commit -m "feat(cli): junco auth grant — one-command bot access for a repo"
```

---

### Task 5: Dashboard add-repo wiring — `ensureBotAccess`

**Files:**

- Modify: `src/tui/ghClient.ts` (`DashboardClient` interface ~:143; `GhClientDeps` ~:167; client factory)
- Modify: `src/tui/App.tsx` (`handleAddRepo` owned-path tail, after `showToast("success", \`watching ${nwo}\`)` ~:1238)
- Test: `tests/tuiGhClient.test.ts`, plus the existing add-repo App specs (find them: `grep -rn "handleAddRepo\|watching " tests/tui*.test.tsx | head`)

**Interfaces:**

- Consumes: `classifyRepoAccess`, `grantBotAccess` (Tasks 1-2); the existing `attempt()` Result wrapper and `withBotAuthFn` dep in ghClient.
- Produces: `DashboardClient` gains `ensureBotAccess(nwo: string): Promise<Result<{ skipped: boolean; login?: string }>>` — skipped:true when `botAccount.enabled` is false OR the bot already has push; otherwise runs the grant. `GhClientDeps` gains `classifyFn?: typeof classifyRepoAccess; grantFn?: typeof grantBotAccess;`.

- [ ] **Step 1: Write the failing tests**

In `tests/tuiGhClient.test.ts` (reuse its cfg/client fixtures):

```ts
describe("ensureBotAccess", () => {
  it("skips when botAccount disabled", async () => {
    // cfg with botAccount.enabled=false; grantFn spy must NOT be called;
    // expect { ok: true, value: { skipped: true } }.
  });
  it("skips when the bot already has push", async () => {
    // enabled cfg; withBotAuthFn attaches FAKE_CTX; classifyFn → direct;
    // grantFn spy NOT called; skipped: true.
  });
  it("grants when the bot lacks push", async () => {
    // classifyFn → { mode: "blocked", reason: "no-access" }; grantFn → { login: "junco-agent" };
    // expect { ok: true, value: { skipped: false, login: "junco-agent" } }.
  });
  it("grant failure → error Result (never throws)", async () => {
    // grantFn throws "needs admin"; expect { ok: false, error: /needs admin/ }.
  });
});
```

App wiring spec (in the file that already tests the add-repo success path — find it first): after a successful owned-repo add with `ensureBotAccess` resolving `{ skipped: false, login: "junco-agent" }`, a toast contains "bot" and "junco-agent"; with an error Result, a warning toast contains `junco auth grant` and the repo is STILL in the watchlist.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tuiGhClient.test.ts > /tmp/gc.out 2>&1; echo "exit: $?"`
Expected: FAIL — `ensureBotAccess` is not a function.

- [ ] **Step 3: Implement**

`src/tui/ghClient.ts` — interface (after `prepareExternalRepo`):

```ts
  /** After adding a watched repo: make sure the BOT can push to it. Skips
   * (ok, skipped:true) when bot mode is off or access already exists;
   * otherwise runs the invite-as-operator/accept-as-bot grant. */
  ensureBotAccess(nwo: string): Promise<Result<{ skipped: boolean; login?: string }>>;
```

Factory method (next to `prepareExternalRepo`; imports from `../botAccess.js`):

```ts
    ensureBotAccess(nwo) {
      return attempt(async () => {
        if (!cfg.botAccount.enabled) return { skipped: true };
        const botCfg = await (deps.withBotAuthFn ?? ((c: Config) => withBotAuth(c)))(cfg);
        const access = await (deps.classifyFn ?? classifyRepoAccess)(botCfg, nwo, { ghFn });
        if (access.mode === "direct") return { skipped: true };
        const { login } = await (deps.grantFn ?? grantBotAccess)(cfg, nwo, { ghFn });
        return { skipped: false, login };
      });
    },
```

`src/tui/App.tsx` — in `handleAddRepo`, replace the owned-path tail's final toast:

```ts
setView("main");
showToast("success", `watching ${nwo}`);
// Bot mode: make sure the DAEMON's identity can push here too — the
// operator's own permission (checked above) says nothing about the
// bot's. Failure warns with the fix but never un-adds the repo.
const grant = await client.ensureBotAccess(nwo);
if (!aliveRef.current) return;
if (!grant.ok) {
  showToast("error", `bot lacks access — run: junco auth grant ${nwo}`);
} else if (!grant.value.skipped) {
  showToast("success", `bot ${grant.value.login} granted write on ${nwo}`);
}
```

(Every fake `DashboardClient` in the TUI test suites needs the new method — typecheck reveals them; default stub: `ensureBotAccess: async () => ({ ok: true as const, value: { skipped: true } })`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tuiGhClient.test.ts > /tmp/gc.out 2>&1; echo "exit: $?"` then the add-repo App spec file, then typecheck (`npx tsc --noEmit -p tsconfig.eslint.json`) to sweep the client fakes, then the full suite — PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/ghClient.ts src/tui/App.tsx
git add -A && git commit -m "feat(dashboard): auto-grant bot access when watching a repo"
```

---

### Task 6: Doctor grant hints + SAML mapping; wizard flight receipts

**Files:**

- Modify: `src/doctor.ts` (bot-account probe ~:190-227; per-repo permission block ~:445-475)
- Modify: `src/wizard/detect.ts` (`flightChecks` at :107)
- Test: `tests/doctor.test.ts`, `tests/wizardDetect.test.ts`

**Interfaces:**

- Consumes: `SAML_MARKER` from `src/botAccess.ts` (Task 1); `junco auth grant` copy (Task 4).
- Produces: doctor's TRIAGE and other-level warnings end with `— fix: junco auth grant <nwo>`; the bot `api user` probe and per-repo permission probe map a SAML-marker stderr to `fail`/`warn` with `authorize gh for the org in the bot's browser session`; `flightChecks` (bot mode only) appends one `bot access: <nwo>` receipt per `cfg.github.repos` entry — ok on push+, warn `run: junco auth grant <nwo>` otherwise.

- [ ] **Step 1: Write the failing tests**

`tests/doctor.test.ts` (extend the T8 bot-mode describe; the fakes already gate on `opts?.env?.GH_CONFIG_DIR`):

```ts
it("per-repo warnings name the grant command", async () => {
  // TRIAGE fixture from the existing test: assert the printed line matches
  // /junco auth grant acme\/api/.
});
it("SAML-blocked bot probe → SSO guidance", async () => {
  // bot `api user` fake returns { code: 1, stderr: "HTTP 403: Resource protected by organization SAML enforcement" }
  // → expect "✗ bot account" line matching /authorize gh for the org/.
});
```

`tests/wizardDetect.test.ts`:

```ts
it("flightChecks: bot-access receipt per watched repo in bot mode", async () => {
  // cfg with botAccount.enabled=true, configDir "/sbx/junco-gh",
  // github.repos = [{ nwo: "acme/api", path: "/r" }]; execFn answers
  // `repo view acme/api --json viewerPermission` with WRITE only when
  // opts?.env?.GH_CONFIG_DIR === "/sbx/junco-gh" (verdict-flipping mismatch arm).
  // Expect a CheckResult { verdict: "ok", label: "bot access: acme/api" }.
  // Second case: READ → verdict "warn", detail matching /junco auth grant acme\/api/.
  // Third case: botAccount.enabled=false → NO "bot access:" receipts at all.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/doctor.test.ts tests/wizardDetect.test.ts > /tmp/dw.out 2>&1; echo "exit: $?"`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**

`src/doctor.ts`:

- TRIAGE warn detail becomes `"triage — label edits work, branch pushes will fail — fix: junco auth grant " + repo.nwo`; the other-level warn detail becomes `` `${level ?? "unknown"} — fix: junco auth grant ${repo.nwo}` ``.
- In the bot `api user` failure branch and the per-repo permission probe: when the probe's stderr includes `SAML_MARKER` (import from `./botAccess.js`), report `fail`/`warn` with detail `"bot token blocked by SAML enforcement — authorize gh for the org in the bot's browser session"` instead of the generic message.

`src/wizard/detect.ts` — at the end of `flightChecks`, before `return out;`:

```ts
// Bot mode: one receipt per watched repo — can the DAEMON's identity push?
// Read-only (the wizard never mutates GitHub); the fix is the CLI command.
if (cfg.botAccount.enabled) {
  for (const repo of cfg.github.repos) {
    const r = await execFn(cfg.ghBin, ["repo", "view", repo.nwo, "--json", "viewerPermission"], {
      env: { GH_CONFIG_DIR: cfg.botAccount.configDir, GH_TOKEN: "", GITHUB_TOKEN: "" },
    });
    let level: string | null = null;
    try {
      level =
        r.code === 0
          ? (JSON.parse(r.stdout) as { viewerPermission: string | null }).viewerPermission
          : null;
    } catch {
      /* inconclusive → warn below */
    }
    out.push(
      level === "ADMIN" || level === "MAINTAIN" || level === "WRITE"
        ? { verdict: "ok", label: `bot access: ${repo.nwo}`, detail: level.toLowerCase() }
        : {
            verdict: "warn",
            label: `bot access: ${repo.nwo}`,
            detail: `no push — run: junco auth grant ${repo.nwo}`,
          },
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/doctor.test.ts tests/wizardDetect.test.ts > /tmp/dw.out 2>&1; echo "exit: $?"` — PASS. Full suite — PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/doctor.ts src/wizard/detect.ts
git add -A && git commit -m "feat(doctor): actionable grant hints + SAML guidance; wizard bot-access receipts"
```

---

### Task 7: Docs + full gate

**Files:**

- Modify: `docs/bot-account.md` (new "Working in an organization" section + dispatch classification table)
- Modify: `ARCHITECTURE.md` (module map: `botAccess.ts`; one clause in the auth-seam paragraph for permission-aware provisioning)
- Modify: `README.md` (`auth grant` in the command table)
- Modify: `CHANGELOG.md` (Unreleased → Added)
- Test: none (prose) — the gate is the deliverable

**Interfaces:** none. Content requirements (verify every claim against the shipped code, not the spec):

- [ ] **Step 1: Write the org section** in `docs/bot-account.md`: `junco auth grant <owner/repo>` and its two-identity mechanics (invite as you — needs admin; accept + verify as the bot; idempotent); the dashboard add-repo auto-grant; the one-time SSO token authorization for SAML orgs (browser step in the bot's session — not automatable); the seat note (outside collaborators on private repos consume a license seat on paid GitHub plans); the org-team alternative (add the bot to a team once instead of per-repo grants — documented, not automated). Then the dispatch classification table: unwatched repo → bot has push = direct branches + auto-onboard (bridge sweeps it from then on) / public without push = fork-PR mode / private without push = blocked with the grant hint.
- [ ] **Step 2: Update the other three docs.** ARCHITECTURE: `botAccess.ts` module-map row + extend the auth-section's provisioning clause with "permission-aware (direct/fork/blocked)". README: `auth grant` row next to `auth login`. CHANGELOG Unreleased/Added: "Permission-aware repo access: `junco auth grant`, dashboard auto-grant, and direct-mode auto-onboard for repos the bot can push to (fork mode unchanged for public repos)".
- [ ] **Step 3: Full gate**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test > /tmp/gate.out 2>&1; echo "exit: $?"`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: organization access guide — grants, SSO, classification table"
```

---

## Self-Review (done at plan-write time)

1. **Spec coverage:** classification → T1; grant → T2; permission-aware dispatch + auto-onboard + assess override + ambient-mode message variant → T3; CLI verb → T4; dashboard wiring (failure never un-adds) → T5; doctor hints + SAML + wizard receipts → T6; docs incl. seats/SSO/team-alternative → T7. Boundary rule (daemon never grants) is structural — grant is only reachable from authCmd/ghClient; no daemon task exists to check.
2. **Placeholder scan:** T3/T5/T6 test sketches name exact assertions and delegate scaffolding to the named files' existing fixtures — each says which file and which helper to reuse; T5's ensureBotAccess tests enumerate all four cases with expected Results. No TBDs.
3. **Type consistency:** `RepoAccess`/`BotAccessDeps`/`classifyRepoAccess(cfg, nwo, deps)`/`grantBotAccess(cfg, nwo, deps) → { login }` identical across T1-T6; `classifyFn?: typeof classifyRepoAccess` name identical in T3 (externalDispatch) and T5 (ghClient); grant-hint copy identical in T3/T4/T5/T6 and the Global Constraints block.
