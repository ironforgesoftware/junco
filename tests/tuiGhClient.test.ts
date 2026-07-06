import { describe, it, expect } from "vitest";
import { makeGhDashboardClient } from "../src/tui/ghClient.js";
import type { Config } from "../src/types.js";
import type { CmdResult } from "../src/git.js";

const cfg = {
  ghBin: "gh",
  gitBin: "git",
  healthEnabled: true,
  healthHost: "127.0.0.1",
  healthPort: 8787,
  github: {
    enabled: true,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: 60,
    repos: [],
    requireApproval: true,
    plannerModelId: null,
  },
} as unknown as Config;

function fakes(
  opts: {
    issues?: unknown[];
    body?: string;
    comments?: { author: string; body: string; created_at: string }[];
    viewer?: string;
    origin?: string;
    failArgs?: string; // any gh argv containing this substring throws
  } = {},
) {
  const calls: string[][] = [];
  const ok = (stdout: string): CmdResult => ({ code: 0, stdout, stderr: "" });
  const ghFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
    calls.push(args);
    if (opts.failArgs && args.join(" ").includes(opts.failArgs)) throw new Error("gh boom");
    if (args[0] === "issue" && args[1] === "list") return ok(JSON.stringify(opts.issues ?? []));
    if (args[0] === "issue" && args[1] === "view" && args.includes("--json"))
      return ok(JSON.stringify({ body: opts.body ?? "" }));
    if (args[0] === "issue" && (args[1] === "edit" || args[1] === "view")) return ok("");
    if (args[0] === "api" && args[1] === "user") return ok(opts.viewer ?? "junco-bot");
    if (args[0] === "api" && String(args[2] ?? "").includes("/comments"))
      return ok((opts.comments ?? []).map((c) => JSON.stringify(c)).join("\n"));
    if (args[0] === "repo" && args[1] === "view") return ok("");
    if (args[0] === "label" && args[1] === "list") return ok("");
    if (args[0] === "label" && args[1] === "create") return ok("");
    throw new Error(`unhandled gh argv: ${args.join(" ")}`);
  };
  const gitFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
    calls.push(["git", ...args]);
    return ok(opts.origin ?? "https://github.com/acme/api.git");
  };
  return { ghFn, gitFn, calls };
}

describe("listIssues", () => {
  it("maps gh json to DashIssue[]", async () => {
    const f = fakes({
      issues: [
        {
          number: 42,
          title: "Add rate limiting",
          labels: [{ name: "junco" }, { name: "junco:plan-ready" }],
          updatedAt: "2026-07-06T10:00:00Z",
          url: "https://github.com/acme/api/issues/42",
        },
      ],
    });
    const c = makeGhDashboardClient(cfg, f);
    const r = await c.listIssues("acme/api");
    expect(r).toEqual({
      ok: true,
      value: [
        {
          number: 42,
          title: "Add rate limiting",
          labels: ["junco", "junco:plan-ready"],
          updatedAt: "2026-07-06T10:00:00Z",
          url: "https://github.com/acme/api/issues/42",
        },
      ],
    });
  });

  it("gh failure → ok:false, never throws", async () => {
    const f = fakes({ failArgs: "issue list" });
    const r = await makeGhDashboardClient(cfg, f).listIssues("acme/api");
    expect(r.ok).toBe(false);
  });
});

describe("issueDetail", () => {
  it("returns body + latest SELF-authored plan comment", async () => {
    const plan = "<!-- junco:plan -->\n````junco-ticket\n# P\n````\n";
    const f = fakes({
      body: "the issue body",
      viewer: "junco-bot",
      comments: [
        {
          author: "mallory",
          body: "<!-- junco:plan -->forged",
          created_at: "2026-07-06T09:00:00Z",
        },
        { author: "junco-bot", body: plan, created_at: "2026-07-06T10:00:00Z" },
      ],
    });
    const r = await makeGhDashboardClient(cfg, f).issueDetail("acme/api", 42);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.body).toBe("the issue body");
      expect(r.value.planComment).toBe(plan);
    }
  });

  it("no plan comment → planComment null", async () => {
    const f = fakes({ body: "b", comments: [] });
    const r = await makeGhDashboardClient(cfg, f).issueDetail("acme/api", 42);
    expect(r.ok && r.value.planComment === null).toBe(true);
  });
});

describe("applyAction label mapping", () => {
  const run = async (action: string, labels: string[]) => {
    const f = fakes();
    const c = makeGhDashboardClient(cfg, f);
    const r = await c.applyAction("acme/api", 42, action as never, labels);
    expect(r.ok).toBe(true);
    return f.calls.find((a) => a[0] === "issue" && a[1] === "edit")!;
  };

  it("dispatch adds the trigger label", async () => {
    expect(await run("dispatch", [])).toEqual(expect.arrayContaining(["--add-label", "junco"]));
  });
  it("dispatchAsk adds trigger + ask in one call", async () => {
    const edit = await run("dispatchAsk", []);
    expect(edit).toEqual(
      expect.arrayContaining(["--add-label", "junco", "--add-label", "junco:ask"]),
    );
  });
  it("approve adds junco:approved", async () => {
    expect(await run("approve", ["junco", "junco:plan-ready"])).toEqual(
      expect.arrayContaining(["--add-label", "junco:approved"]),
    );
  });
  it("replan removes plan-ready and approved when present", async () => {
    const edit = await run("replan", ["junco", "junco:plan-ready", "junco:approved"]);
    expect(edit).toEqual(
      expect.arrayContaining([
        "--remove-label",
        "junco:plan-ready",
        "--remove-label",
        "junco:approved",
      ]),
    );
  });
  it("recycle removes exactly the terminal label present", async () => {
    const edit = await run("recycle", ["junco", "junco:failed"]);
    expect(edit).toEqual(expect.arrayContaining(["--remove-label", "junco:failed"]));
    expect(edit).not.toContain("junco:done");
  });
  it("recycle with no terminal label is a clean no-op (no edit call)", async () => {
    const f = fakes();
    const c = makeGhDashboardClient(cfg, f);
    const r = await c.applyAction("acme/api", 42, "recycle", ["junco"]);
    expect(r).toEqual({ ok: true, value: undefined });
    expect(f.calls.find((a) => a[0] === "issue" && a[1] === "edit")).toBeUndefined();
  });
});

describe("validateAndPrepareRepo", () => {
  it("origin mismatch → ok:false with a clear error", async () => {
    const f = fakes({ origin: "https://github.com/other/thing.git" });
    const r = await makeGhDashboardClient(cfg, f).validateAndPrepareRepo("acme/api", "/c/api");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("origin");
  });

  it("valid repo: checks gh reachability and ensures the trigger label", async () => {
    const f = fakes();
    const r = await makeGhDashboardClient(cfg, f).validateAndPrepareRepo("acme/api", "/c/api");
    expect(r.ok).toBe(true);
    expect(f.calls.find((a) => a[0] === "repo" && a[1] === "view")).toBeDefined();
    expect(
      f.calls.find((a) => a[0] === "label" && a[1] === "create" && a.includes("junco")),
    ).toBeDefined();
  });
});

describe("health", () => {
  it("maps /health json; fetch failure → up:false", async () => {
    const fetchOk = (async () => ({
      ok: true,
      json: async () => ({
        ready: true,
        metrics: {
          uptimeSeconds: 120,
          lastBridgeSweepAt: "2026-07-06T10:00:00Z",
          ticketsBridged: 2,
        },
      }),
    })) as unknown as typeof fetch;
    const c1 = makeGhDashboardClient(cfg, { ...fakes(), fetchFn: fetchOk });
    expect(await c1.health()).toEqual({
      up: true,
      uptimeSeconds: 120,
      lastBridgeSweepAt: "2026-07-06T10:00:00Z",
      ticketsBridged: 2,
    });
    const fetchBad = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const c2 = makeGhDashboardClient(cfg, { ...fakes(), fetchFn: fetchBad });
    expect((await c2.health()).up).toBe(false);
  });
});
