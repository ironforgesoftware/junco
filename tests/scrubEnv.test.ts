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
