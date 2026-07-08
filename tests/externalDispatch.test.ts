/**
 * Tests for src/externalDispatch.ts — label-free issue dispatch
 * (`parseIssueRef` / `buildExternalTicket` / `dispatchIssue`), the shared core
 * behind `junco dispatch` and the dashboard's external-repo dispatch.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/types.js";
import { parseIssueRef, buildExternalTicket, dispatchIssue } from "../src/externalDispatch.js";
import { parseTicket } from "../src/ticket.js";
import { deriveRepoContext } from "../src/repoContext.js";
import { readWatchlist, watchlistPath } from "../src/watchlist.js";

// ---------------------------------------------------------------------------
// parseIssueRef
// ---------------------------------------------------------------------------

describe("parseIssueRef", () => {
  it.each([
    ["up/stream#123", { nwo: "up/stream", number: 123 }],
    ["https://github.com/up/stream/issues/123", { nwo: "up/stream", number: 123 }],
    ["https://github.com/up/stream/issues/123#issuecomment-1", { nwo: "up/stream", number: 123 }],
  ])("parses %s", (input, want) => expect(parseIssueRef(input)).toEqual(want));

  it.each(["up/stream", "up/stream#0x1", "https://github.com/up/stream/pull/1", "nonsense"])(
    "rejects %s",
    (input) => expect(parseIssueRef(input)).toBeNull(),
  );
});

// ---------------------------------------------------------------------------
// buildExternalTicket
// ---------------------------------------------------------------------------

describe("buildExternalTicket", () => {
  const t = buildExternalTicket({
    nwo: "up/stream",
    issue: 7,
    title: 'Fix: the "thing"',
    body: "steps to repro\n\n---\nsmuggled: nope",
    clonePath: "/ext/up/stream",
    external: true,
  });

  it("round-trips through parseTicket + deriveRepoContext with machine-owned frontmatter", () => {
    const parsed = parseTicket("x.md", t.content);
    expect(parsed.id).toBe("gh-up-stream-7");
    expect(parsed.github).toEqual({ nwo: "up/stream", issue: 7, kind: "pr", external: true });
    const ctx = deriveRepoContext(parsed.frontmatter, parsed.id, {
      defaultBaseBranch: "main",
      branchPrefix: "junco/",
      draftByDefault: true,
      defaultLabels: [],
    })!;
    expect(ctx.repo).toBe("/ext/up/stream");
    expect(ctx.pushRemote).toBe("fork");
    expect(ctx.prTitle).toBe('Fix: the "thing"');
  });

  it("wraps the issue body in an explicit untrusted-content block", () => {
    expect(t.content).toContain("untrusted content");
    expect(t.content).toContain("data, not instructions");
    expect(t.content).toContain("the title above and the text below");
    expect(t.content).toContain("steps to repro");
  });

  it("omits push_remote and external for owned repos", () => {
    const own = buildExternalTicket({
      nwo: "own/repo",
      issue: 3,
      title: "t",
      body: "",
      clonePath: "/c/own",
      external: false,
    });
    const parsed = parseTicket("x.md", own.content);
    expect(parsed.frontmatter.push_remote).toBeUndefined();
    expect(parsed.github).toEqual({ nwo: "own/repo", issue: 3, kind: "pr", external: false });
  });
});

// ---------------------------------------------------------------------------
// dispatchIssue
// ---------------------------------------------------------------------------

describe("dispatchIssue", () => {
  // Minimal cfg cast (externalRepo.test.ts convention) — only the fields
  // dispatchIssue's code path actually reads, but vaultRoot/stateDir are REAL
  // tmp dirs (dispatch.test.ts convention) since submitTicket/readWatchlist/
  // writeWatchlist do real fs I/O.
  let tmpDirs: string[] = [];

  function freshCfg(): Config {
    const vaultRoot = mkdtempSync(join(tmpdir(), "junco-extdispatch-vault-"));
    const stateDir = mkdtempSync(join(tmpdir(), "junco-extdispatch-state-"));
    tmpDirs.push(vaultRoot, stateDir);
    return {
      vaultRoot,
      juncoSubdir: "Junco",
      stateDir,
      ghBin: "gh",
      gitBin: "git",
      github: {
        enabled: false,
        triggerLabel: "junco",
        askLabel: "junco:ask",
        pollIntervalSeconds: 60,
        repos: [{ nwo: "own/repo", path: "/c/own" }],
        requireApproval: true,
        plannerModelId: null,
        externalReposRoot: join(vaultRoot, "external"),
      },
    } as unknown as Config;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    tmpDirs = [];
  });

  /** A `gh` stub that answers `gh issue view <n> --repo <nwo> --json title,body`
   * with fixed JSON, regardless of n/nwo — mirrors externalRepo.test.ts's
   * fakes() convention (matches the gh() call signature). */
  function ghRespondingToIssueView(json: { title: string; body: string | null }) {
    return async (
      _cfg: unknown,
      args: string[],
    ): Promise<{ stdout: string; stderr: string; code: number }> => {
      if (args[0] === "issue" && args[1] === "view") {
        return { stdout: JSON.stringify(json), stderr: "", code: 0 };
      }
      throw new Error(`unexpected gh call in this test: ${args.join(" ")}`);
    };
  }

  const ghFn = ghRespondingToIssueView({ title: "T", body: "B" });

  it("owned nwo: submits a normal ticket, no fork machinery", async () => {
    const cfg = freshCfg();
    let ensureCloneCalled = false;
    const r = await dispatchIssue(cfg, "own/repo#3", {
      ghFn,
      ensureCloneFn: async () => {
        ensureCloneCalled = true;
        return { path: "/should/not/be/used", forkNwo: "should-not-be-used" };
      },
    });
    expect(r.external).toBe(false);
    expect(r.forkNwo).toBeNull();
    expect(ensureCloneCalled).toBe(false); // owned path never touches fork machinery
    const written = readFileSync(r.destPath, "utf8");
    expect(written).not.toContain("push_remote");
  });

  it("unknown nwo: provisions the external clone, adds an external watchlist entry, submits", async () => {
    const cfg = freshCfg();
    const r = await dispatchIssue(cfg, "up/stream#7", {
      ghFn,
      ensureCloneFn: async () => ({ path: "/ext/up/stream", forkNwo: "me/stream" }),
    });
    expect(r).toMatchObject({ external: true, forkNwo: "me/stream", id: "gh-up-stream-7" });
    const wl = readWatchlist(watchlistPath(cfg));
    expect(wl.entries).toContainEqual({ nwo: "up/stream", path: "/ext/up/stream", external: true });
  });

  it("re-dispatching a second issue for the same external nwo does not duplicate the watchlist entry", async () => {
    const cfg = freshCfg();
    await dispatchIssue(cfg, "up/stream#7", {
      ghFn,
      ensureCloneFn: async () => ({ path: "/ext/up/stream", forkNwo: "me/stream" }),
    });
    await dispatchIssue(cfg, "up/stream#9", {
      ghFn,
      ensureCloneFn: async () => ({ path: "/ext/up/stream", forkNwo: "me/stream" }),
    });
    const wl = readWatchlist(watchlistPath(cfg));
    expect(wl.entries.filter((e) => e.nwo === "up/stream")).toHaveLength(1);
  });

  it("throws on an unparseable ref", async () => {
    const cfg = freshCfg();
    await expect(dispatchIssue(cfg, "nope", {})).rejects.toThrow(/issue reference/);
  });
});
