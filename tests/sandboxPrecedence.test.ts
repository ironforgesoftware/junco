import { describe, expect, it } from "vitest";
import { orderRules, resolveRead, type ReadRule } from "../src/agent/sandbox/precedence.js";

const sub = (path: string, effect: "allow" | "deny"): ReadRule => ({
  path,
  effect,
  kind: "subtree",
});
const file = (path: string, effect: "allow" | "deny"): ReadRule => ({ path, effect, kind: "file" });

// The real #277 shape, three levels deep.
const JUNCO: ReadRule[] = [
  sub("/sbxroot/.junco", "deny"),
  sub("/sbxroot/.junco/cache", "allow"),
  sub("/sbxroot/.junco/cache/mirror", "deny"),
  sub("/sbxroot/.junco/cache/github-cache", "deny"),
];

describe("resolveRead", () => {
  it("allows a path no rule covers", () => {
    expect(resolveRead("/sbxroot/elsewhere", JUNCO)).toBe("allow");
  });

  it("denies the wholesale root", () => {
    expect(resolveRead("/sbxroot/.junco/config.json", JUNCO)).toBe("deny");
  });

  it("allows a subtree that overrides the root deny", () => {
    expect(resolveRead("/sbxroot/.junco/cache/worktrees/t1", JUNCO)).toBe("allow");
  });

  // THE regression this whole task exists to prevent.
  it("re-denies a subtree nested inside an allow-back (longest prefix wins)", () => {
    expect(resolveRead("/sbxroot/.junco/cache/mirror/repo.git", JUNCO)).toBe("deny");
    expect(resolveRead("/sbxroot/.junco/cache/github-cache/x.json", JUNCO)).toBe("deny");
  });

  it("matches on path boundaries, not string prefixes", () => {
    // /sbxroot/.junco-backup must not be caught by the /sbxroot/.junco deny.
    expect(resolveRead("/sbxroot/.junco-backup/f", JUNCO)).toBe("allow");
    // ...and the allow for cache must not leak to cache-extra.
    expect(resolveRead("/sbxroot/.junco/cache-extra/f", JUNCO)).toBe("deny");
  });

  it("applies an exact-file rule over a subtree rule at the same path", () => {
    const rules = [sub("/sbxroot/d", "allow"), file("/sbxroot/d", "deny")];
    expect(resolveRead("/sbxroot/d", rules)).toBe("deny");
    // the file rule is exact: descendants still follow the subtree rule
    expect(resolveRead("/sbxroot/d/child", rules)).toBe("allow");
  });

  it("prefers deny when an allow and a deny tie exactly", () => {
    expect(
      resolveRead("/sbxroot/d/f", [sub("/sbxroot/d", "allow"), sub("/sbxroot/d", "deny")]),
    ).toBe("deny");
  });

  it("is independent of input order", () => {
    const shuffled = [JUNCO[2], JUNCO[0], JUNCO[3], JUNCO[1]];
    expect(resolveRead("/sbxroot/.junco/cache/mirror/r", shuffled)).toBe("deny");
    expect(resolveRead("/sbxroot/.junco/cache/worktrees/t", shuffled)).toBe("allow");
  });
});

describe("orderRules", () => {
  it("emits least-specific first so last-match-wins backends agree", () => {
    const out = orderRules([JUNCO[2], JUNCO[0], JUNCO[1]]).map((r) => r.path);
    expect(out).toEqual([
      "/sbxroot/.junco",
      "/sbxroot/.junco/cache",
      "/sbxroot/.junco/cache/mirror",
    ]);
  });

  it("agrees with resolveRead for every rule path in the set", () => {
    // Cross-check: emitting in orderRules order and taking the LAST match
    // must give the same answer as resolveRead's longest-prefix search.
    const probes = [
      "/sbxroot/.junco/config.json",
      "/sbxroot/.junco/cache/worktrees/t1",
      "/sbxroot/.junco/cache/mirror/r.git",
      "/sbxroot/nowhere",
    ];
    const ordered = orderRules(JUNCO);
    for (const p of probes) {
      const lastMatch = [...ordered]
        .reverse()
        .find((r) =>
          r.kind === "file" ? p === r.path : p === r.path || p.startsWith(r.path + "/"),
        );
      expect(lastMatch?.effect ?? "allow").toBe(resolveRead(p, JUNCO));
    }
  });
});
