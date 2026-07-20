import { describe, expect, it } from "vitest";
import {
  buildUnifiedRepos,
  buildRailRows,
  resolveRailIndex,
  bodyKindFor,
  rowKey,
  sysKey,
  SYSTEM_SECTIONS,
  type WatchedMapping,
} from "../src/tui/railModel.js";
import type { LocalRepo } from "../src/tui/localSnapshot.js";

const heavyRepo = (over: Partial<LocalRepo>): LocalRepo => ({
  nwo: null,
  path: "/x",
  source: "clone",
  originUrl: null,
  forkUrl: null,
  githubUrl: null,
  branch: null,
  headSha: null,
  dirty: null,
  error: null,
  ...over,
});
const watched = (nwo: string, path: string, fromConfig = false): WatchedMapping => ({
  nwo,
  path,
  fromConfig,
  external: false,
});

describe("buildUnifiedRepos", () => {
  it("watched rows come first with git enrichment matched by path", () => {
    const rows = buildUnifiedRepos(
      [watched("Acme/API", "/w/api", true)],
      [
        heavyRepo({
          nwo: "acme/api",
          path: "/w/api",
          branch: "main",
          dirty: true,
          source: "config",
        }),
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("acme/api"); // nwo lowercased
    expect(rows[0].watched).toBe(true);
    expect(rows[0].source).toBe("config");
    expect(rows[0].git?.branch).toBe("main");
    expect(rows[0].git?.dirty).toBe(true);
  });

  it("a same-nwo stray clone collapses into the watched row as a clones entry", () => {
    const rows = buildUnifiedRepos(
      [watched("acme/api", "/w/api")],
      [
        heavyRepo({ nwo: "acme/api", path: "/w/api", branch: "main" }),
        heavyRepo({ nwo: "acme/api", path: "/data/clones/acme/api", source: "clone" }),
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].clones).toEqual(["/data/clones/acme/api"]);
    expect(rows[0].git?.branch).toBe("main"); // primary = the watched path match
  });

  it("a watched row with only a same-nwo clone at another path still enriches", () => {
    const rows = buildUnifiedRepos(
      [watched("acme/api", "/w/api")],
      [heavyRepo({ nwo: "acme/api", path: "/data/clones/acme/api", branch: "trunk" })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].git?.branch).toBe("trunk");
    expect(rows[0].clones).toEqual([]); // the primary is not ALSO a clone line
  });

  it("unmatched heavy candidates append as unwatched rows keyed by path", () => {
    const rows = buildUnifiedRepos(
      [watched("acme/api", "/w/api")],
      [heavyRepo({ nwo: null, path: "/dev/scratch", source: "clone" })],
    );
    expect(rows).toHaveLength(2);
    expect(rows[1].watched).toBe(false);
    expect(rows[1].nwo).toBeNull();
    expect(rows[1].key).toBe("/dev/scratch");
  });

  it("an unwatched candidate WITH an nwo stays a discovered row keyed by path", () => {
    const rows = buildUnifiedRepos(
      [],
      [heavyRepo({ nwo: "octo/ext", path: "/ext/octo/ext", source: "external" })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].nwo).toBe("octo/ext");
    expect(rows[0].watched).toBe(false);
    expect(rows[0].key).toBe("/ext/octo/ext");
  });

  it("null heavy (pre-first-tick) still yields the watched rows, git null", () => {
    const rows = buildUnifiedRepos([watched("acme/api", "/w/api")], null);
    expect(rows).toHaveLength(1);
    expect(rows[0].git).toBeNull();
    expect(rows[0].clones).toEqual([]);
  });
});

describe("buildRailRows / keys", () => {
  it("appends the five system rows after the repos", () => {
    const rows = buildRailRows(buildUnifiedRepos([watched("a/b", "/p")], null));
    expect(rows).toHaveLength(1 + SYSTEM_SECTIONS.length);
    expect(rows[1]).toEqual({ kind: "system", section: "queue" });
    expect(rowKey(rows[1])).toBe(sysKey("queue"));
    expect(rowKey(rows[0])).toBe("a/b");
  });
});

describe("resolveRailIndex", () => {
  const rows = buildRailRows(buildUnifiedRepos([watched("a/b", "/p"), watched("c/d", "/q")], null));

  it("resolves a live key", () => {
    expect(resolveRailIndex(rows, "c/d", 0)).toBe(1);
    expect(resolveRailIndex(rows, sysKey("daemon"), 0)).toBe(5);
  });

  it("falls back to the clamped last index when the key is gone", () => {
    expect(resolveRailIndex(rows, "gone/gone", 99)).toBe(rows.length - 1);
    expect(resolveRailIndex(rows, null, 1)).toBe(1);
    expect(resolveRailIndex([], "a/b", 3)).toBe(0);
  });

  it("selection survives a repo-list insertion (the key-anchor point)", () => {
    const grown = buildRailRows(
      buildUnifiedRepos(
        [watched("a/b", "/p"), watched("c/d", "/q")],
        [heavyRepo({ nwo: null, path: "/new/clone" })],
      ),
    );
    expect(resolveRailIndex(grown, sysKey("queue"), 2)).toBe(3); // still the queue row
  });
});

describe("bodyKindFor", () => {
  const repos = buildUnifiedRepos(
    [watched("a/b", "/p")],
    [heavyRepo({ nwo: null, path: "/dev/scratch" })],
  );
  const rows = buildRailRows(repos);

  it("watched nwo row + github enabled → issues", () => {
    expect(bodyKindFor(rows[0], true)).toEqual({ kind: "issues", nwo: "a/b" });
  });

  it("watched nwo row + github disabled → repoDetail", () => {
    expect(bodyKindFor(rows[0], false)?.kind).toBe("repoDetail");
  });

  it("unwatched row → repoDetail regardless", () => {
    expect(bodyKindFor(rows[1], true)?.kind).toBe("repoDetail");
  });

  it("system row → section; undefined → null", () => {
    expect(bodyKindFor(rows[2], true)).toEqual({ kind: "section", section: "queue" });
    expect(bodyKindFor(undefined, true)).toBeNull();
  });
});
