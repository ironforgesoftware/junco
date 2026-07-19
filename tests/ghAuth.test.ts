import { describe, it, expect } from "vitest";
import type { spawn } from "node:child_process";
import {
  resolveBotAuth,
  withBotAuth,
  withFileAsAuth,
  detectBotLogin,
  runGhLogin,
} from "../src/ghAuth.js";

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
      credentialHelper: '!"gh" auth git-credential',
    });
    expect(calls[0].env).toEqual({
      GH_CONFIG_DIR: "/sbx/junco-gh",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
    });
  });

  it("throws an actionable error when enabled but not logged in", async () => {
    const { execFn } = fakeExec({}); // api user → exit 1
    await expect(resolveBotAuth(ENABLED, { execFn })).rejects.toThrow(/junco auth login/);
  });

  // #187.1: `gh api user` returning valid-JSON-but-missing-fields must not
  // sail through to email "undefined+undefined@…" and a later spawn TypeError.
  it("rejects shapeless JSON ({} — no login/id) instead of building an undefined email", async () => {
    const { execFn } = fakeExec({ "api user": { code: 0, stdout: "{}" } });
    await expect(resolveBotAuth(ENABLED, { execFn })).rejects.toThrow(/could not parse/);
    await expect(resolveBotAuth(ENABLED, { execFn })).rejects.not.toThrow(/undefined\+undefined/);
  });

  // #187.2: a missing gh binary (exit 127 in the exec seam) is a distinct
  // failure from a genuinely absent login — say so precisely.
  it("distinguishes a missing gh binary (exit 127) from a missing login", async () => {
    const { execFn } = fakeExec({ "api user": { code: 127, stdout: "" } });
    await expect(resolveBotAuth(ENABLED, { execFn })).rejects.toThrow(
      /gh (binary )?not found|not found/i,
    );
    await expect(resolveBotAuth(ENABLED, { execFn })).rejects.not.toThrow(/junco auth login/);
  });

  // #187.4: git shell-splits `!`-helpers, so a ghBin path with spaces must be
  // quoted in the credential helper.
  it("quotes a ghBin containing spaces in the credential helper", async () => {
    const { execFn } = fakeExec({ "api user": { code: 0, stdout: USER_JSON } });
    const ctx = await resolveBotAuth(
      { botAccount: { enabled: true, configDir: "/sbx/junco-gh" }, ghBin: "/opt/my tools/gh" },
      { execFn },
    );
    expect(ctx?.credentialHelper).toBe('!"/opt/my tools/gh" auth git-credential');
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

describe("runGhLogin", () => {
  /** Stub child: fires exactly one event (async, like a real ChildProcess). */
  function stubChild(fire: { event: "close" | "error"; arg?: unknown }) {
    return {
      on(event: string, cb: (arg?: unknown) => void) {
        if (event === fire.event) setImmediate(() => cb(fire.arg));
      },
    };
  }

  it("resolves 1 (never throws/rejects) when mkdir fails", async () => {
    const spawnFn = (() => stubChild({ event: "close", arg: 0 })) as unknown as typeof spawn;
    const mkdirFn = () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    // Must return a promise even when mkdir throws — callers use .then/.catch.
    const p = runGhLogin("gh", "/sbx/junco-gh", { spawnFn, mkdirFn });
    expect(p).toBeInstanceOf(Promise);
    await expect(p).resolves.toBe(1);
  });

  it("mkdirs first, then spawns gh auth login with inherited stdio + GH_CONFIG_DIR; resolves 0", async () => {
    const order: string[] = [];
    const spawnCalls: Array<{
      cmd: string;
      args: string[];
      opts: { stdio?: unknown; env?: Record<string, string> };
    }> = [];
    const spawnFn = ((
      cmd: string,
      args: string[],
      opts: { stdio?: unknown; env?: Record<string, string> },
    ) => {
      order.push("spawn");
      spawnCalls.push({ cmd, args, opts });
      return stubChild({ event: "close", arg: 0 });
    }) as unknown as typeof spawn;
    const mkdirCalls: string[] = [];
    const mkdirFn = (p: string) => {
      order.push("mkdir");
      mkdirCalls.push(p);
    };
    const code = await runGhLogin("gh", "/sbx/junco-gh", { spawnFn, mkdirFn });
    expect(code).toBe(0);
    expect(mkdirCalls).toEqual(["/sbx/junco-gh"]);
    expect(order).toEqual(["mkdir", "spawn"]);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe("gh");
    expect(spawnCalls[0].args).toEqual([
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--git-protocol",
      "https",
      "--web",
    ]);
    expect(spawnCalls[0].opts.stdio).toBe("inherit");
    expect(spawnCalls[0].opts.env?.GH_CONFIG_DIR).toBe("/sbx/junco-gh");
  });

  it("resolves 127 when spawn errors (binary missing)", async () => {
    const spawnFn = (() =>
      stubChild({ event: "error", arg: new Error("ENOENT") })) as unknown as typeof spawn;
    await expect(runGhLogin("gh", "/sbx/junco-gh", { spawnFn, mkdirFn: () => {} })).resolves.toBe(
      127,
    );
  });

  it("resolves with the child's non-zero exit code", async () => {
    const spawnFn = (() => stubChild({ event: "close", arg: 3 })) as unknown as typeof spawn;
    await expect(runGhLogin("gh", "/sbx/junco-gh", { spawnFn, mkdirFn: () => {} })).resolves.toBe(
      3,
    );
  });
});

describe("withFileAsAuth", () => {
  const bot = { enabled: true, configDir: "/sbx/junco-gh" };

  it('fileAs "me": returns cfg unchanged, execs nothing', async () => {
    const { execFn, calls } = fakeExec({});
    const cfg = { botAccount: bot, ghBin: "gh", assess: { fileAs: "me" as const } };
    const out = await withFileAsAuth(cfg, { execFn });
    expect(out).toBe(cfg);
    expect(calls).toHaveLength(0);
  });

  it('fileAs "bot" with botAccount disabled: fails loud, execs nothing, never falls back', async () => {
    const { execFn, calls } = fakeExec({ "api user": { code: 0, stdout: USER_JSON } });
    await expect(
      withFileAsAuth(
        {
          botAccount: { enabled: false, configDir: "/sbx/junco-gh" },
          ghBin: "gh",
          assess: { fileAs: "bot" as const },
        },
        { execFn },
      ),
    ).rejects.toThrow(/assess\.fileAs.*botAccount\.enabled|junco auth login/);
    expect(calls).toHaveLength(0);
  });

  it('fileAs "bot" with a working login: attaches the bot context (isolated GH_CONFIG_DIR)', async () => {
    const { execFn, calls } = fakeExec({ "api user": { code: 0, stdout: USER_JSON } });
    const out = await withFileAsAuth(
      { botAccount: bot, ghBin: "gh", assess: { fileAs: "bot" as const } },
      { execFn },
    );
    expect(out.ghAuth?.login).toBe("junco-agent");
    expect(out.ghAuth?.configDir).toBe("/sbx/junco-gh");
    expect(calls[0]?.env?.GH_CONFIG_DIR).toBe("/sbx/junco-gh");
    expect(calls[0]?.env?.GH_TOKEN).toBe("");
  });

  it('fileAs "bot" with a broken login: rejects with the actionable auth-login message', async () => {
    const { execFn } = fakeExec({ "api user": { code: 1, stdout: "" } });
    await expect(
      withFileAsAuth(
        { botAccount: bot, ghBin: "gh", assess: { fileAs: "bot" as const } },
        { execFn },
      ),
    ).rejects.toThrow(/junco auth login/);
  });
});
