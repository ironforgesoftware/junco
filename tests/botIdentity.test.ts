import { describe, it, expect } from "vitest";
import { resolveBotLogin } from "../src/botIdentity.js";

const cfg = (enabled: boolean) => ({ botAccount: { enabled, configDir: "/tmp/ghcfg" } });

describe("resolveBotLogin", () => {
  it("null when the bot account is disabled (no exec)", async () => {
    let called = false;
    const login = await resolveBotLogin(cfg(false), {
      execFn: async () => ((called = true), { code: 0, stdout: "x" }),
    });
    expect(login).toBeNull();
    expect(called).toBe(false);
  });
  it("resolves the login under the isolated config dir with tokens cleared", async () => {
    let seenEnv: NodeJS.ProcessEnv = {};
    const login = await resolveBotLogin(cfg(true), {
      execFn: async (_cmd, _args, env) => ((seenEnv = env), { code: 0, stdout: "junco-bot\n" }),
    });
    expect(login).toBe("junco-bot");
    expect(seenEnv.GH_CONFIG_DIR).toBe("/tmp/ghcfg");
    expect(seenEnv.GH_TOKEN).toBe("");
    expect(seenEnv.GITHUB_TOKEN).toBe("");
  });
  it("null on probe failure or empty output", async () => {
    expect(
      await resolveBotLogin(cfg(true), { execFn: async () => ({ code: 1, stdout: "" }) }),
    ).toBeNull();
    expect(
      await resolveBotLogin(cfg(true), { execFn: async () => ({ code: 0, stdout: "  " }) }),
    ).toBeNull();
  });
});
