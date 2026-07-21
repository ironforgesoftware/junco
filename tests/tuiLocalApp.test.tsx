// App-level unified-view suite: the single rail (repos + system rows), body
// routing per row kind, the removed mode toggle, and github-disabled
// fallbacks. (The file name is tuiLocalApp for continuity with the LOCAL-mode
// suite it replaced; the section-component suite owns tuiLocal.)
// Fixtures + renderApp live in ./helpers/localFixtures.
import { describe, it, expect, afterEach } from "vitest";
import { cleanup } from "ink-testing-library";
import type { LocalCheap, LocalHeavy } from "../src/tui/localSnapshot.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import { until } from "./helpers/until.js";
import {
  renderApp,
  CHEAP,
  HEAVY,
  ESC,
  stubClient,
  TO_QUEUE_ROW,
  TO_WORKTREES_ROW,
  TO_DAEMON_ROW,
  tap,
} from "./helpers/localFixtures.js";

afterEach(cleanup);

describe("unified rail", () => {
  it("renders repos and the pinned system rows in ONE rail at mount", async () => {
    const r = renderApp();
    await until(() => {
      const f = r.lastFrame() ?? "";
      return (
        f.includes("acme/api") &&
        f.includes("beta/two") &&
        f.includes("system") &&
        f.includes("queue") &&
        f.includes("outbox") &&
        f.includes("worktrees") &&
        f.includes("daemon") &&
        f.includes("logs")
      );
    });
  });

  it("mode tabs are gone: no [GITHUB]/[LOCAL] anywhere", async () => {
    const r = renderApp();
    await until(() => (r.lastFrame() ?? "").includes("system"));
    const f = r.lastFrame() ?? "";
    expect(f).not.toContain("[GITHUB]");
    expect(f).not.toContain("[LOCAL]");
  });

  it("m toggles nothing (regression: the retired mode key)", async () => {
    const r = renderApp();
    await until(() => (r.lastFrame() ?? "").includes("First issue")); // issues body up
    r.stdin.write("m");
    // Bounded spin: let any (buggy) mode swap commit before asserting.
    for (let i = 0; i < 20; i++) await new Promise((res) => setTimeout(res, 1));
    const f = r.lastFrame() ?? "";
    expect(f).toContain("First issue"); // still the issues body — no surface swap
    expect(f).not.toContain("[LOCAL]");
    expect(f).not.toContain("sections"); // the old LOCAL section rail never mounts
  });

  it("j walks off the repos into the system rows; body follows the cursor", async () => {
    const r = renderApp();
    await until(() => (r.lastFrame() ?? "").includes("system"));
    await tap(r, TO_QUEUE_ROW); // acme/api → beta/two → queue
    // Queue body: the fixture's waiting ticket renders.
    await until(() => (r.lastFrame() ?? "").includes("sub-fix-typos"));
    // The rail's queue ROW carries the ▌ cursor (the body title also says
    // "queue", so match cursor + label on one line).
    expect(
      (r.lastFrame() ?? "").split("\n").some((l) => l.includes("▌") && l.includes("queue")),
    ).toBe(true);
  });

  it("the queue mnemonic (e) jumps straight to the queue system row and focuses the body", async () => {
    const r = renderApp();
    await until(() => (r.lastFrame() ?? "").includes("system"));
    r.stdin.write("e"); // qu[e]ue — q reserved for quit, u taken by unwatch
    await until(() => (r.lastFrame() ?? "").includes("sub-fix-typos"));
    // The queue row carries the cursor even though we never pressed j.
    expect(
      (r.lastFrame() ?? "").split("\n").some((l) => l.includes("▌") && l.includes("queue")),
    ).toBe(true);
  });

  it("selection is key-anchored: a heavy-poll discovery does not move the cursor", async () => {
    let heavy: LocalHeavy = HEAVY;
    const r = renderApp({ localHeavyFn: async () => heavy, localHeavyPollMs: 30 });
    await until(() => (r.lastFrame() ?? "").includes("system"));
    await tap(r, TO_QUEUE_ROW); // park on the queue system row
    await until(() =>
      (r.lastFrame() ?? "").split("\n").some((l) => l.includes("▌") && l.includes("queue")),
    );
    // A new local-only clone appears — the repo prefix grows by one row.
    heavy = {
      ...HEAVY,
      repos: [
        ...HEAVY.repos,
        {
          nwo: null,
          path: "/dev/scratch",
          source: "clone",
          originUrl: null,
          forkUrl: null,
          githubUrl: null,
          branch: null,
          headSha: null,
          dirty: null,
          error: null,
        },
      ],
    };
    await until(() => (r.lastFrame() ?? "").includes("scratch"));
    // The cursor is STILL on the queue row (an index anchor would now sit on
    // the discovered repo row instead).
    expect(
      (r.lastFrame() ?? "").split("\n").some((l) => l.includes("▌") && l.includes("queue")),
    ).toBe(true);
  });
});

describe("section bodies", () => {
  it("worktrees row renders the worktrees body (fix-typos, stale)", async () => {
    const r = renderApp();
    await until(() => (r.lastFrame() ?? "").includes("system"));
    await tap(r, TO_WORKTREES_ROW);
    await until(() => {
      const f = r.lastFrame() ?? "";
      return f.includes("fix-typos") && f.includes("stale");
    });
  });

  it("daemon row shows pid, guard, tokens", async () => {
    const r = renderApp();
    await until(() => (r.lastFrame() ?? "").includes("system"));
    await tap(r, TO_DAEMON_ROW);
    await until(() => {
      const f = r.lastFrame() ?? "";
      return f.includes("4242") && f.includes("guard");
    });
  });

  it("daemon-down and outbox snapshot-error render without collapsing the frame", async () => {
    const down: LocalCheap = {
      ...CHEAP,
      daemon: { ...CHEAP.daemon, up: false, pid: null, endpointReachable: false },
      outbox: { depth: 0, dead: 0, ops: [], deadOps: [], error: "boom" },
    };
    const r = renderApp({ localCheapFn: async () => down });
    await until(() => (r.lastFrame() ?? "").includes("system"));
    await tap(r, TO_DAEMON_ROW);
    await until(() => {
      const f = r.lastFrame() ?? "";
      return f.includes("state") && f.includes("down");
    });
    await tap(r, "kk"); // daemon → worktrees → outbox
    await until(() => (r.lastFrame() ?? "").includes("unavailable"));
  });

  it("← in a section body returns focus to the rail (hints flip back)", async () => {
    const r = renderApp();
    await until(() => (r.lastFrame() ?? "").includes("system"));
    await tap(r, TO_QUEUE_ROW);
    await until(() => (r.lastFrame() ?? "").includes("sub-fix-typos"));
    r.stdin.write("l"); // ensure body focus
    await until(() => (r.lastFrame() ?? "").includes("retry"));
    r.stdin.write(ESC);
    await until(() => (r.lastFrame() ?? "").includes("add repo")); // rail hint set
  });
});

describe("github disabled", () => {
  it("nwo rows render the RepoDetail body instead of issues", async () => {
    const r = renderApp({ githubEnabled: false });
    await until(() => {
      const f = r.lastFrame() ?? "";
      // RepoDetail for acme/api: path + enriched git state from HEAVY.
      return f.includes("path") && f.includes("/c/api") && f.includes("main@abc1234");
    });
    expect(r.lastFrame()).not.toContain("First issue"); // the issues list never mounts
  });

  it("never fires a gh cycle: listIssues and listPrs stay uncalled", async () => {
    let issues = 0;
    let prs = 0;
    const counting: DashboardClient = {
      ...stubClient,
      listIssues: async () => {
        issues++;
        return { ok: true, value: { issues: [], staleAt: null } };
      },
      listPrs: async () => {
        prs++;
        return { ok: true, value: { prs: [], staleAt: null } };
      },
    };
    const r = renderApp({ githubEnabled: false, client: counting });
    await until(() => (r.lastFrame() ?? "").includes("system"));
    for (let i = 0; i < 20; i++) await new Promise((res) => setTimeout(res, 1));
    expect(issues).toBe(0);
    expect(prs).toBe(0);
  });

  it("w toasts that github is off instead of opening add-repo", async () => {
    const r = renderApp({ githubEnabled: false });
    await until(() => (r.lastFrame() ?? "").includes("system"));
    r.stdin.write("a"); // [a]dd repo mnemonic
    await until(() => (r.lastFrame() ?? "").toLowerCase().includes("github mode is off"));
    expect(r.lastFrame()).not.toContain("add repo to watchlist");
  });
});

describe("gh error toast scoping", () => {
  it("an issues poll that fails AFTER moving to a section body does not toast", async () => {
    // The mount cycle fetches the selected repo's issues immediately; hold
    // that promise until the cursor has moved onto a section row, then fail
    // it — the late error must not flash a toast over the section body.
    // (Object holder, not a let: TS's flow analysis can't see the closure
    // assignment and would narrow a bare variable to `null` at the call site.)
    const release: { fn: (() => void) | null } = { fn: null };
    const failing: DashboardClient = {
      ...stubClient,
      listIssues: () =>
        new Promise((res) => {
          release.fn = () => res({ ok: false, error: "gh boom" });
        }),
    };
    const r = renderApp({ client: failing });
    await until(() => (r.lastFrame() ?? "").includes("system"));
    await tap(r, TO_QUEUE_ROW); // park on the queue system row
    await until(() => (r.lastFrame() ?? "").includes("sub-fix-typos"));
    await until(() => release.fn !== null); // the mount fetch is in flight
    release.fn?.();
    // Give any resulting toast time to commit (bounded spin — a single fixed
    // tick would race React; the loop lets a buggy toast surface if it will).
    for (let i = 0; i < 20; i++) await new Promise((res) => setTimeout(res, 1));
    expect(r.lastFrame()).not.toContain("gh boom");
  });
});

describe("RepoDetail view (enter on a rail repo row)", () => {
  it("enter opens the full-width detail; esc returns to main", async () => {
    const r = renderApp();
    await until(() => (r.lastFrame() ?? "").includes("system"));
    r.stdin.write("\r"); // enter on acme/api (cursor starts there)
    await until(() => {
      const f = r.lastFrame() ?? "";
      return f.includes("/c/api") && f.includes("worktrees") && f.includes("recent tickets");
    });
    r.stdin.write(ESC);
    await until(() => (r.lastFrame() ?? "").includes("First issue")); // issues body is back
  });

  it("a local-only repo row shows RepoDetail as its pane-2 body", async () => {
    const heavy: LocalHeavy = {
      ...HEAVY,
      repos: [
        ...HEAVY.repos,
        {
          nwo: null,
          path: "/dev/scratch",
          source: "clone",
          originUrl: null,
          forkUrl: null,
          githubUrl: null,
          branch: "main",
          headSha: "beefcafe00001111",
          dirty: true,
          error: null,
        },
      ],
    };
    const r = renderApp({ localHeavyFn: async () => heavy });
    await until(() => (r.lastFrame() ?? "").includes("scratch"));
    await tap(r, "jj"); // acme/api → beta/two → /dev/scratch (discovered row)
    await until(() => {
      const f = r.lastFrame() ?? "";
      return f.includes("/dev/scratch") && f.includes("main@beefcaf") && f.includes("✎ dirty");
    });
  });
});

describe("config editor", () => {
  it(", opens the config editor and Esc returns to the unified view", async () => {
    const r = renderApp({ githubEnabled: false });
    await until(() => (r.lastFrame() ?? "").includes("system"));
    r.stdin.write(",");
    // Description text for the initially-focused `vaultRoot` lever — unique
    // ConfigView chrome, not something the unified body ever renders.
    await until(() => (r.lastFrame() ?? "").includes("Root directory Junco keeps"));
    r.stdin.write(ESC);
    await until(() => !(r.lastFrame() ?? "").includes("Root directory Junco keeps"));
    const f = r.lastFrame() ?? "";
    expect(f).toContain("queue");
    expect(f).toContain("daemon");
  });
});
