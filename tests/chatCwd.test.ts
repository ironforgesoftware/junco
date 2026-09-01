import { describe, it, expect } from "vitest";
import { resolveChatCwd } from "../src/chat/chatCwd.js";
import { makeConfig } from "./helpers/config.js";
import type { CmdResult } from "../src/git.js";

const cfg = makeConfig({
  dataDir: "/sbxroot/data",
  queueRoot: "/sbxroot/data/queue",
  worktreeRoot: "/sbxroot/wt",
  tools: [],
  criticEnabled: false,
  planLintEnabled: false,
  verifyEnabled: false,
  supervisorEnabled: false,
  healthEnabled: false,
  removeWorktreeOnSuccess: true,
});
const ok = (stdout: string): CmdResult => ({ code: 0, stdout, stderr: "" });

describe("resolveChatCwd (spec 2026-09-01 §2.2)", () => {
  it("watched key → the watchlist entry's path when it exists", async () => {
    const r = await resolveChatCwd(cfg, "acme/api", {
      watchedFn: () => [{ nwo: "Acme/API", path: "/sbxroot/clones/acme/api" }],
      existsFn: (p) => p === "/sbxroot/clones/acme/api",
    });
    expect(r).toEqual({
      ok: true,
      cwd: "/sbxroot/clones/acme/api",
      kind: "watched",
      nwo: "Acme/API",
    });
  });
  it("watched key whose checkout is missing → no_checkout", async () => {
    const r = await resolveChatCwd(cfg, "acme/api", {
      watchedFn: () => [{ nwo: "acme/api", path: "/gone" }],
      existsFn: () => false,
    });
    expect(r).toEqual({ ok: false, error: "no_checkout" });
  });
  it("unknown nwo → unknown_key", async () => {
    const r = await resolveChatCwd(cfg, "nobody/nothing", { watchedFn: () => [] });
    expect(r).toEqual({ ok: false, error: "unknown_key" });
  });
  it("local key → itself when it is a git toplevel outside dataDir", async () => {
    const r = await resolveChatCwd(cfg, "/home/me/api", {
      existsFn: () => true,
      realpathFn: (p) => p,
      gitFn: async () => ok("/home/me/api\n"),
    });
    expect(r).toEqual({ ok: true, cwd: "/home/me/api", kind: "local", nwo: null });
  });
  it("local key inside dataDir, or not a toplevel, → not_a_repo", async () => {
    const inside = await resolveChatCwd(cfg, "/sbxroot/data/chats/x", {
      existsFn: () => true,
      realpathFn: (p) => p,
      gitFn: async () => ok("/sbxroot/data/chats/x\n"),
    });
    expect(inside).toEqual({ ok: false, error: "not_a_repo" });
    const sub = await resolveChatCwd(cfg, "/home/me/api/src", {
      existsFn: () => true,
      realpathFn: (p) => p,
      gitFn: async () => ok("/home/me/api\n"),
    });
    expect(sub).toEqual({ ok: false, error: "not_a_repo" });
    const notGit = await resolveChatCwd(cfg, "/tmp/plain", {
      existsFn: () => true,
      realpathFn: (p) => p,
      gitFn: async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }),
    });
    expect(notGit).toEqual({ ok: false, error: "not_a_repo" });
  });
  it("local key inside a SYMLINKED data dir is still not_a_repo (both sides realpath'd)", async () => {
    const linked = { ...cfg, dataDir: "/sbxroot/link" };
    const map: Record<string, string> = {
      "/sbxroot/link": "/sbxroot/real",
      "/sbxroot/real/chats/x": "/sbxroot/real/chats/x",
    };
    const r = await resolveChatCwd(linked, "/sbxroot/real/chats/x", {
      existsFn: () => true,
      realpathFn: (p) => map[p] ?? p,
      gitFn: async () => ok("/sbxroot/real/chats/x\n"),
    });
    expect(r).toEqual({ ok: false, error: "not_a_repo" });
  });
  it("realpathFn throws for dataDir only → fallback to resolve(), local key outside → ok", async () => {
    const r = await resolveChatCwd(cfg, "/home/me/api", {
      existsFn: () => true,
      realpathFn: (p) => {
        if (p === "/sbxroot/data") throw new Error("ENOENT");
        return p;
      },
      gitFn: async () => ok("/home/me/api\n"),
    });
    expect(r).toEqual({ ok: true, cwd: "/home/me/api", kind: "local", nwo: null });
  });
});
