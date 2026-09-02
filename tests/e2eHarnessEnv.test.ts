import { describe, it, expect, vi, afterEach } from "vitest";
import { childEnv } from "./e2e/harness.js";

describe("childEnv (e2e harness)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("anchors HOME/XDG/TMPDIR in the sandbox and passes through only the toolchain vars", () => {
    vi.stubEnv("HOME", "/Users/real-person");
    vi.stubEnv("XDG_CONFIG_HOME", "/Users/real-person/.config");
    vi.stubEnv("JUNCO_CONFIG", "/Users/real-person/.junco/config.json");
    vi.stubEnv("JUNCO_E2E_LIVE", "1");
    vi.stubEnv("OPENAI_API_KEY", "sk-should-not-leak");
    vi.stubEnv("PATH", "/usr/bin:/bin");
    // Stub every passthrough var so the expected key list does not depend on
    // what the developer's shell happens to export.
    vi.stubEnv("LANG", "en_US.UTF-8");
    vi.stubEnv("LC_ALL", "C");
    vi.stubEnv("LC_CTYPE", "UTF-8");

    const env = childEnv("/sbx/home");

    expect(env.HOME).toBe("/sbx/home");
    expect(env.XDG_CONFIG_HOME).toBe("/sbx/home/.config");
    expect(env.TMPDIR).toBe("/sbx/home/tmp");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.LC_ALL).toBe("C");
    expect(env.GIT_AUTHOR_NAME).toBe("e2e");
    const leaked = Object.keys(env).filter((k) => k.startsWith("JUNCO_") || k === "OPENAI_API_KEY");
    expect(leaked).toEqual([]);
    expect(Object.keys(env).sort()).toEqual(
      [
        "GIT_AUTHOR_EMAIL",
        "GIT_AUTHOR_NAME",
        "GIT_COMMITTER_EMAIL",
        "GIT_COMMITTER_NAME",
        "HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "PATH",
        "TMPDIR",
        "XDG_CONFIG_HOME",
      ].sort(),
    );
  });

  it("omits passthrough vars that are unset rather than writing 'undefined'", () => {
    vi.stubEnv("LANG", "");
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    const env = childEnv("/sbx/home");
    expect("LC_ALL" in env).toBe(false);
    expect(env.LANG).toBe("");
  });
});
