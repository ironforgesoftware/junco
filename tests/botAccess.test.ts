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
