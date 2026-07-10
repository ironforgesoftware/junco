import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  externalClonePath,
  ensureFork,
  ensureExternalClone,
  syncExternalClone,
} from "../src/externalRepo.js";
import type { Config } from "../src/types.js";

// Minimal cfg: only ghBin/gitBin/github.externalReposRoot are read.
const cfg = {
  ghBin: "gh",
  gitBin: "git",
  github: { externalReposRoot: "/ext" },
} as unknown as Config;

type Call = { bin: "gh" | "git"; args: string[] };
function fakes(script: (c: Call) => { stdout?: string; code?: number }) {
  const calls: Call[] = [];
  const mk =
    (bin: "gh" | "git") =>
    async (
      _cfg: unknown,
      args: string[],
    ): Promise<{ stdout: string; stderr: string; code: number }> => {
      const call = { bin, args };
      calls.push(call);
      const r = script(call);
      const code = r.code ?? 0;
      if (code !== 0 && bin === "gh") throw new Error(`gh failed: ${args.join(" ")}`);
      return { stdout: r.stdout ?? "", stderr: "", code };
    };
  return { calls, ghFn: mk("gh") as never, gitFn: mk("git") as never };
}

describe("externalClonePath", () => {
  it("nests owner/repo under the configured root", () => {
    expect(externalClonePath(cfg, "up/stream")).toBe(join("/ext", "up", "stream"));
  });

  it("throws when a `..`-bearing nwo would escape external_repos_root", () => {
    // The nwo regexes admit `..` and every reachable caller gates on `gh`
    // today, but containment must not rest on an external tool's validation.
    expect(() => externalClonePath(cfg, "../evil")).toThrow(/external_repos_root/);
  });

  it("throws when the nwo collapses back onto the root itself", () => {
    expect(() => externalClonePath(cfg, "up/..")).toThrow(/external_repos_root/);
  });
});

describe("ensureFork", () => {
  it("forks idempotently and verifies the fork's parent", async () => {
    const f = fakes((c) => {
      const a = c.args.join(" ");
      if (a === "repo fork up/stream --clone=false") return {};
      if (a === "api user --jq .login") return { stdout: "me\n" };
      if (a === "repo view me/stream --json parent")
        return { stdout: JSON.stringify({ parent: { name: "stream", owner: { login: "up" } } }) };
      return { code: 1 };
    });
    await expect(ensureFork(cfg, "up/stream", f)).resolves.toBe("me/stream");
    expect(f.calls[0]).toEqual({ bin: "gh", args: ["repo", "fork", "up/stream", "--clone=false"] });
  });

  it("throws when me/<repo> is not a fork of the upstream", async () => {
    const f = fakes((c) => {
      const a = c.args.join(" ");
      if (a === "repo fork up/stream --clone=false") return {};
      if (a === "api user --jq .login") return { stdout: "me\n" };
      if (a === "repo view me/stream --json parent")
        return {
          stdout: JSON.stringify({ parent: { name: "else", owner: { login: "someone" } } }),
        };
      return { code: 1 };
    });
    await expect(ensureFork(cfg, "up/stream", f)).rejects.toThrow(/not a fork of up\/stream/);
  });

  it("throws with '(parent: none)' when the candidate has no parent at all", async () => {
    const f = fakes((c) => {
      const a = c.args.join(" ");
      if (a === "repo fork up/stream --clone=false") return {};
      if (a === "api user --jq .login") return { stdout: "me\n" };
      if (a === "repo view me/stream --json parent")
        return { stdout: JSON.stringify({ parent: null }) };
      return { code: 1 };
    });
    await expect(ensureFork(cfg, "up/stream", f)).rejects.toThrow(/parent: none/);
  });
});

describe("ensureExternalClone", () => {
  it("existing clone with a fork remote: derives forkNwo from the URL, zero gh calls", async () => {
    const f = fakes((c) => {
      if (c.bin === "git" && c.args.join(" ").endsWith("config --get remote.origin.url"))
        return { stdout: "https://github.com/up/stream.git\n" };
      if (c.bin === "git" && c.args.join(" ").endsWith("config --get remote.fork.url"))
        return { stdout: "https://github.com/me/stream.git\n" };
      return { code: 1 };
    });
    const r = await ensureExternalClone(cfg, "up/stream", { ...f, existsFn: () => true });
    expect(r).toEqual({ path: join("/ext", "up", "stream"), forkNwo: "me/stream" });
    expect(f.calls.filter((c) => c.bin === "gh")).toHaveLength(0);
  });

  it("existing clone without a fork remote: provisions the fork and adds the remote", async () => {
    const f = fakes((c) => {
      const a = c.args.join(" ");
      if (c.bin === "git" && a.endsWith("config --get remote.origin.url"))
        return { stdout: "https://github.com/up/stream.git\n" };
      if (c.bin === "git" && a.endsWith("config --get remote.fork.url")) return { code: 1 }; // absent
      if (
        c.bin === "git" &&
        a === `-C ${join("/ext", "up", "stream")} remote add fork https://github.com/me/stream.git`
      )
        return {};
      if (a === "repo fork up/stream --clone=false") return {};
      if (a === "api user --jq .login") return { stdout: "me\n" };
      if (a === "repo view me/stream --json parent")
        return { stdout: JSON.stringify({ parent: { name: "stream", owner: { login: "up" } } }) };
      return { code: 1 };
    });
    const r = await ensureExternalClone(cfg, "up/stream", { ...f, existsFn: () => true });
    expect(r).toEqual({ path: join("/ext", "up", "stream"), forkNwo: "me/stream" });
    const addCall = f.calls.find(
      (c) => c.bin === "git" && c.args.join(" ").includes("remote add fork"),
    );
    expect(addCall).toBeDefined();
    expect(f.calls.some((c) => c.bin === "gh" && c.args.join(" ").startsWith("repo clone"))).toBe(
      false,
    );
  });

  it("throws when the existing fork remote URL is not a github.com URL", async () => {
    const f = fakes((c) => {
      const a = c.args.join(" ");
      if (c.bin === "git" && a.endsWith("config --get remote.origin.url"))
        return { stdout: "https://github.com/up/stream.git\n" };
      if (c.bin === "git" && a.endsWith("config --get remote.fork.url"))
        return { stdout: "git://weird/thing\n" };
      return { code: 1 };
    });
    await expect(
      ensureExternalClone(cfg, "up/stream", { ...f, existsFn: () => true }),
    ).rejects.toThrow(/fork.*remote/i);
  });

  it("fresh: clones upstream, forks, adds the fork remote", async () => {
    const made: string[] = [];
    const f = fakes((c) => {
      const a = c.args.join(" ");
      if (a === `repo clone up/stream ${join("/ext", "up", "stream")}`) return {};
      if (a === "repo fork up/stream --clone=false") return {};
      if (a === "api user --jq .login") return { stdout: "me\n" };
      if (a === "repo view me/stream --json parent")
        return { stdout: JSON.stringify({ parent: { name: "stream", owner: { login: "up" } } }) };
      if (c.bin === "git" && a.includes("remote add fork https://github.com/me/stream.git"))
        return {};
      if (c.bin === "git" && a.endsWith("remote get-url fork")) return { code: 1 }; // not yet added
      return { code: 1 };
    });
    const r = await ensureExternalClone(cfg, "up/stream", {
      ...f,
      existsFn: () => false,
      mkdirFn: (d) => void made.push(d),
    });
    expect(r.forkNwo).toBe("me/stream");
    expect(made.length).toBeGreaterThan(0);
  });

  it("refuses an existing dir whose origin is not the upstream", async () => {
    const f = fakes((c) => {
      if (c.bin === "git" && c.args.join(" ").endsWith("config --get remote.origin.url"))
        return { stdout: "https://github.com/other/thing.git\n" };
      return { code: 1 };
    });
    await expect(
      ensureExternalClone(cfg, "up/stream", { ...f, existsFn: () => true }),
    ).rejects.toThrow(/origin/);
  });
});

describe("syncExternalClone", () => {
  it("fetches origin and hard-resets to the default branch", async () => {
    const f = fakes((c) => {
      if (c.bin === "git" && c.args.includes("symbolic-ref"))
        return { stdout: "refs/remotes/origin/main\n" };
      return {};
    });
    await syncExternalClone(cfg, join("/ext", "o", "r"), f);
    expect(f.calls.some((c) => c.args.includes("fetch") && c.args.includes("origin"))).toBe(true);
    const reset = f.calls.find((c) => c.args.includes("reset"));
    expect(reset).toBeDefined();
    expect(reset?.args).toContain("--hard");
    expect(reset?.args).toContain("origin/main");
  });

  it("falls back to origin/HEAD when symbolic-ref is unset", async () => {
    const f = fakes((c) => {
      if (c.bin === "git" && c.args.includes("symbolic-ref")) return { code: 1 }; // unset
      return {};
    });
    await syncExternalClone(cfg, join("/ext", "o", "r"), f);
    const reset = f.calls.find((c) => c.args.includes("reset"));
    expect(reset?.args).toContain("--hard");
    expect(reset?.args).toContain("origin/HEAD");
  });

  it("refuses to hard-reset a target outside external_repos_root", async () => {
    // The destructive fetch/reset must self-guard: no reachable caller may aim
    // it at a path outside the root junco owns, regardless of upstream gating.
    const f = fakes(() => ({}));
    await expect(syncExternalClone(cfg, "/outside/o/r", f)).rejects.toThrow(/external_repos_root/);
    expect(f.calls).toHaveLength(0); // rejected before any git ran
  });
});
