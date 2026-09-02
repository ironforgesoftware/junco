import { describe, it, expect, beforeEach, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { makePiSessionFactory } from "../src/agent/session.js";
import { makeConfig } from "./helpers/config.js";

/**
 * makePiSessionFactory's non-sandbox appendSystemPrompt branch (Task 12,
 * spec 2026-09-01 §6.5, session.ts ~865-882) is reached only through the
 * factory's own dynamic `await import("@earendil-works/pi-coding-agent")` —
 * there is no injectable seam for it (unlike resolveSandbox/buildSandbox,
 * which take their SDK factories as an argument). This mocks the SDK module
 * itself (the same `vi.mock` + `importOriginal` partial-mock pattern
 * session.test.ts already uses for `node:fs`) so the real factory function
 * runs end to end, with a fake DefaultResourceLoader/createAgentSession/
 * ModelRuntime standing in for the real ones. Scoped to its own file — a
 * file-level SDK mock here would break session.test.ts's other tests, which
 * deliberately exercise the REAL SDK's ModelRuntime.
 */
const sdkFake = vi.hoisted(() => {
  const loaderCtorCalls: Record<string, unknown>[] = [];
  const events: string[] = [];
  const createAgentSessionCalls: Record<string, unknown>[] = [];
  class FakeResourceLoader {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      loaderCtorCalls.push(opts);
      events.push("loader:construct");
    }
    async reload(): Promise<void> {
      events.push("loader:reload");
    }
  }
  return {
    loaderCtorCalls,
    events,
    createAgentSessionCalls,
    FakeResourceLoader,
    reset(): void {
      loaderCtorCalls.length = 0;
      events.length = 0;
      createAgentSessionCalls.length = 0;
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    DefaultResourceLoader: sdkFake.FakeResourceLoader,
    createAgentSession: async (options: Record<string, unknown>) => {
      sdkFake.events.push("createAgentSession");
      sdkFake.createAgentSessionCalls.push(options);
      return { session: { __fakeSession: true } };
    },
    ModelRuntime: {
      create: async () => ({
        getModel: () => ({ __fakeModel: true }),
        getModels: () => [],
        registerProvider: () => {},
      }),
    },
    SessionManager: { inMemory: () => ({ __tag: "sessionManager" }) },
    SettingsManager: { inMemory: () => ({ __tag: "settingsManager" }) },
  };
});

// sandbox.enabled defaults to false in makeConfig (tests/helpers/config.ts) —
// exactly the "sandbox off" condition this branch requires.
const cfg = makeConfig({
  dataDir: "/sbxroot/data",
  queueRoot: "/sbxroot/data/queue",
  worktreeRoot: "/sbxroot/worktrees",
  tools: ["read"],
  criticEnabled: false,
  planLintEnabled: false,
  verifyEnabled: false,
  supervisorEnabled: false,
  healthEnabled: false,
  removeWorktreeOnSuccess: true,
});

describe("makePiSessionFactory — non-sandbox appendSystemPrompt wiring (Task 12)", () => {
  beforeEach(() => sdkFake.reset());

  it("builds an inert loader with the four extra no* flags + appendSystemPromptOverride, and reloads it before createAgentSession sees it", async () => {
    const factory = makePiSessionFactory(cfg, "/sbxroot/work", {
      appendSystemPrompt: "--- DRAFTING CONTRACT ---\nhi",
    });
    await factory();

    expect(sdkFake.loaderCtorCalls).toHaveLength(1);
    const { appendSystemPromptOverride, ...rest } = sdkFake.loaderCtorCalls[0]!;
    expect(typeof appendSystemPromptOverride).toBe("function");
    expect((appendSystemPromptOverride as (base: string[]) => string[])([])).toEqual([
      "--- DRAFTING CONTRACT ---\nhi",
    ]);
    expect(rest).toEqual({
      cwd: "/sbxroot/work",
      agentDir: join(homedir(), ".pi", "agent"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    // reload() runs before createAgentSession is handed the loader.
    const reloadAt = sdkFake.events.indexOf("loader:reload");
    const createAt = sdkFake.events.indexOf("createAgentSession");
    expect(reloadAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(reloadAt).toBeLessThan(createAt);

    expect(sdkFake.createAgentSessionCalls).toHaveLength(1);
    expect(sdkFake.createAgentSessionCalls[0]!.resourceLoader).toBeInstanceOf(
      sdkFake.FakeResourceLoader,
    );
  });

  it("without appendSystemPrompt, no loader is built and createAgentSession gets no resourceLoader (unchanged pre-Task-12 behavior)", async () => {
    const factory = makePiSessionFactory(cfg, "/sbxroot/work", {});
    await factory();

    expect(sdkFake.loaderCtorCalls).toHaveLength(0);
    expect(sdkFake.events).not.toContain("loader:reload");
    expect(sdkFake.createAgentSessionCalls).toHaveLength(1);
    expect("resourceLoader" in sdkFake.createAgentSessionCalls[0]!).toBe(false);
  });
});
