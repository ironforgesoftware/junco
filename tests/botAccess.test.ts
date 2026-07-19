import { describe, it, expect } from "vitest";
import { classifyRepoAccess, ssoMessage } from "../src/botAccess.js";
import type { Config, GhAuthContext } from "../src/types.js";
import { GitOpError, type CmdResult, type GitCallOpts } from "../src/git.js";

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

  // #192.2: a transient network failure must NOT be classified as
  // blocked/no-access (which prescribes `junco auth grant`) — throw a
  // retryable GitOpError so the real cause surfaces.
  it("network failure → throws GitOpError, not blocked/no-access", async () => {
    const { ghFn } = fakeGh({
      [VIEW]: { code: 1, stderr: "dial tcp: connection refused" },
    });
    await expect(classifyRepoAccess(CFG, "acme/api", { ghFn })).rejects.toBeInstanceOf(GitOpError);
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

describe("ssoMessage (#192.1)", () => {
  it('defaults the subject to "the bot\'s token"', () => {
    const m = ssoMessage("acme/api");
    expect(m).toContain("the bot's token is blocked by SAML enforcement for acme/api");
    expect(m).toContain("in the bot's browser session");
  });

  it('who="you" swaps subject and possessive to the ambient identity', () => {
    const m = ssoMessage("acme/api", "you");
    expect(m).toContain("your gh token is blocked by SAML enforcement for acme/api");
    expect(m).toContain("in your browser session");
    expect(m).not.toContain("the bot's");
  });
});

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
const LIST = "api /user/repository_invitations?per_page=100";
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
    let sleepCalls = 0;
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
      sleepFn: async () => {
        sleepCalls += 1;
      },
    });
    expect(listCount).toBe(2);
    expect(sleepCalls).toBe(1); // one sleep before the second attempt, none before the first
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

  it("verify classifies blocked/sso (operator authorized, bot itself SAML-blocked) → SSO guidance", async () => {
    const { ghFn } = fakeGh2({
      [PUT]: { code: 0, stdout: JSON.stringify({ id: 77 }) },
      [LIST]: {
        code: 0,
        stdout: JSON.stringify([{ id: 77, repository: { full_name: "acme/api" } }]),
      },
      [ACCEPT]: { code: 0, stdout: "" },
      [VIEW_KEY]: {
        code: 1,
        stderr: "HTTP 403: Resource protected by organization SAML enforcement",
      },
    });
    await expect(grantBotAccess(AMBIENT_CFG, "acme/api", { ghFn, withBotAuthFn })).rejects.toThrow(
      /SAML/,
    );
  });

  it("verify classifies fork → generic did-not-take-effect message", async () => {
    const { ghFn } = fakeGh2({
      [PUT]: { code: 0, stdout: JSON.stringify({ id: 77 }) },
      [LIST]: {
        code: 0,
        stdout: JSON.stringify([{ id: 77, repository: { full_name: "acme/api" } }]),
      },
      [ACCEPT]: { code: 0, stdout: "" },
      [VIEW_KEY]: {
        code: 0,
        stdout: JSON.stringify({ viewerPermission: "READ", isPrivate: false }),
      },
    });
    await expect(grantBotAccess(AMBIENT_CFG, "acme/api", { ghFn, withBotAuthFn })).rejects.toThrow(
      /grant did not take effect/,
    );
  });

  it("accept never succeeds → error names manual acceptance and the bot login", async () => {
    let sleepCalls = 0;
    const { ghFn, calls } = fakeGh2({
      [PUT]: { code: 0, stdout: JSON.stringify({ id: 77 }) },
      [LIST]: { code: 0, stdout: "[]" },
    });
    await expect(
      grantBotAccess(AMBIENT_CFG, "acme/api", {
        ghFn,
        withBotAuthFn,
        retryDelayMs: 1,
        sleepFn: async () => {
          sleepCalls += 1;
        },
      }),
    ).rejects.toThrow(/junco-agent/);
    // Retry bound: exactly 3 list attempts, sleeps only BETWEEN attempts.
    expect(calls.filter((c) => c.args.join(" ") === LIST)).toHaveLength(3);
    expect(sleepCalls).toBe(2);
  });
});
