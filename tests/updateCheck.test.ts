import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSelfPackage, compareVersions } from "../src/updateCheck.js";

describe("getSelfPackage", () => {
  it("reads junco's own package.json (never hardcoded)", () => {
    const self = getSelfPackage();
    const pkg = JSON.parse(readFileSync(join(self.rootDir, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(self.name).toBe(pkg.name);
    expect(self.version).toBe(pkg.version);
    expect(self.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("compareVersions", () => {
  it("orders numeric triples", () => {
    expect(compareVersions("0.8.0", "0.7.0")).toBe(1);
    expect(compareVersions("0.7.0", "0.8.0")).toBe(-1);
    expect(compareVersions("0.7.0", "0.7.0")).toBe(0);
    expect(compareVersions("0.7.10", "0.7.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
  });
  it("tolerates a leading v and surrounding whitespace", () => {
    expect(compareVersions("v0.8.0", "0.7.0")).toBe(1);
    expect(compareVersions(" 0.7.0 ", "0.7.0")).toBe(0);
  });
  it("returns null on anything unparseable (prerelease, garbage, empty)", () => {
    expect(compareVersions("0.8.0-beta.1", "0.7.0")).toBeNull();
    expect(compareVersions("0.8", "0.7.0")).toBeNull();
    expect(compareVersions("latest", "0.7.0")).toBeNull();
    expect(compareVersions("", "0.7.0")).toBeNull();
  });
});

import type { Config } from "../src/types.js";
import {
  checkForUpdate,
  FRESH_WINDOW_MS,
  RETRY_BACKOFF_MS,
  type UpdateCheckOpts,
} from "../src/updateCheck.js";

describe("checkForUpdate", () => {
  const NOW = new Date("2026-07-16T12:00:00Z");
  const cfg = { dataDir: "/sbxroot/data", updateCheck: true } as unknown as Config;

  interface Harness {
    opts: UpdateCheckOpts;
    writes: Record<string, string>;
    fetches: string[];
  }
  /** Fake fs keyed by path; rename moves tmp → final like the real thing. */
  const harness = (o: {
    cacheJson?: string;
    registry?: { status: number; body: unknown } | "offline";
  }): Harness => {
    const writes: Record<string, string> = {};
    const fetches: string[] = [];
    const files: Record<string, string> = {};
    if (o.cacheJson !== undefined) files["/sbxroot/data/update-check.json"] = o.cacheJson;
    return {
      writes,
      fetches,
      opts: {
        nowFn: () => NOW,
        selfPkgFn: () => ({ name: "@x/junco", version: "0.7.0", rootDir: "/sbxroot/app" }),
        readFileFn: (p: string) => {
          if (files[p] === undefined) throw new Error("ENOENT");
          return files[p];
        },
        writeFileFn: (p: string, s: string) => {
          writes[p] = s;
          files[p] = s;
        },
        renameFn: (a: string, b: string) => {
          files[b] = files[a];
          writes[b] = writes[a];
        },
        fetchFn: (async (url: string | URL | Request) => {
          fetches.push(String(url));
          if (o.registry === "offline" || o.registry === undefined) throw new Error("offline");
          return {
            ok: o.registry.status === 200,
            status: o.registry.status,
            json: async () => o.registry.body,
          } as Response;
        }) as typeof fetch,
      },
    };
  };
  const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();

  it("fresh cache short-circuits the network and recomputes available live", async () => {
    const h = harness({
      cacheJson: JSON.stringify({ latest: "0.8.0", checkedAt: iso(60_000) }),
    });
    const r = await checkForUpdate(cfg, h.opts);
    expect(h.fetches).toEqual([]);
    expect(r).toEqual({ current: "0.7.0", latest: "0.8.0", available: true });
  });

  it("clears the moment the running version catches up (no cache-expiry wait)", async () => {
    const h = harness({
      cacheJson: JSON.stringify({ latest: "0.7.0", checkedAt: iso(60_000) }),
    });
    const r = await checkForUpdate(cfg, h.opts);
    expect(r).toEqual({ current: "0.7.0", latest: "0.7.0", available: false });
  });

  it("stale cache fetches, rewrites atomically (tmp+rename), returns fresh info", async () => {
    const h = harness({
      cacheJson: JSON.stringify({ latest: "0.7.0", checkedAt: iso(FRESH_WINDOW_MS + 1) }),
      registry: { status: 200, body: { version: "0.8.0" } },
    });
    const r = await checkForUpdate(cfg, h.opts);
    expect(h.fetches).toEqual(["https://registry.npmjs.org/@x/junco/latest"]);
    expect(r).toEqual({ current: "0.7.0", latest: "0.8.0", available: true });
    const written = JSON.parse(h.writes["/sbxroot/data/update-check.json"]) as {
      latest: string;
      checkedAt: string;
    };
    expect(written.latest).toBe("0.8.0");
    expect(h.writes["/sbxroot/data/update-check.json.tmp"]).toBeDefined();
  });

  it("offline with a stale cache serves the stale latest and stamps lastAttempt", async () => {
    const h = harness({
      cacheJson: JSON.stringify({ latest: "0.8.0", checkedAt: iso(FRESH_WINDOW_MS + 1) }),
      registry: "offline",
    });
    const r = await checkForUpdate(cfg, h.opts);
    expect(r).toEqual({ current: "0.7.0", latest: "0.8.0", available: true });
    const written = JSON.parse(h.writes["/sbxroot/data/update-check.json"]) as {
      lastAttempt: string;
    };
    expect(written.lastAttempt).toBe(NOW.toISOString());
  });

  it("offline with no cache returns null (and still stamps lastAttempt)", async () => {
    const h = harness({ registry: "offline" });
    expect(await checkForUpdate(cfg, h.opts)).toBeNull();
    expect(h.writes["/sbxroot/data/update-check.json"]).toContain("lastAttempt");
  });

  it("a recent failed attempt suppresses refetch for RETRY_BACKOFF_MS", async () => {
    const h = harness({
      cacheJson: JSON.stringify({ lastAttempt: iso(RETRY_BACKOFF_MS - 1) }),
      registry: { status: 200, body: { version: "0.8.0" } },
    });
    expect(await checkForUpdate(cfg, h.opts)).toBeNull();
    expect(h.fetches).toEqual([]);
  });

  it("garbage registry payloads are failures, not updates", async () => {
    for (const body of [{ version: "not-semver" }, { nope: 1 }, "junk"]) {
      const h = harness({ registry: { status: 200, body } });
      expect(await checkForUpdate(cfg, h.opts)).toBeNull();
    }
  });

  it("non-2xx is a failure", async () => {
    const h = harness({ registry: { status: 500, body: {} } });
    expect(await checkForUpdate(cfg, h.opts)).toBeNull();
  });

  it("corrupt cache file is treated as missing", async () => {
    const h = harness({
      cacheJson: "{not json",
      registry: { status: 200, body: { version: "0.8.0" } },
    });
    const r = await checkForUpdate(cfg, h.opts);
    expect(r?.available).toBe(true);
  });

  it("updateCheck: false short-circuits everything", async () => {
    const off = { ...cfg, updateCheck: false } as Config;
    const h = harness({ registry: { status: 200, body: { version: "9.9.9" } } });
    expect(await checkForUpdate(off, h.opts)).toBeNull();
    expect(h.fetches).toEqual([]);
  });

  it("forceFresh bypasses both the fresh window and the failure backoff", async () => {
    const h = harness({
      cacheJson: JSON.stringify({
        latest: "0.7.0",
        checkedAt: iso(60_000),
        lastAttempt: iso(60_000),
      }),
      registry: { status: 200, body: { version: "0.8.0" } },
    });
    const r = await checkForUpdate(cfg, { ...h.opts, forceFresh: true });
    expect(h.fetches.length).toBe(1);
    expect(r?.available).toBe(true);
  });

  it("a throwing selfPkgFn resolves null (never rejects)", async () => {
    const h = harness({ registry: { status: 200, body: { version: "0.8.0" } } });
    const opts = {
      ...h.opts,
      selfPkgFn: () => {
        throw new Error("boom");
      },
    };
    await expect(checkForUpdate(cfg, opts)).resolves.toBeNull();
  });
});
