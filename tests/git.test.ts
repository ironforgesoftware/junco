/**
 * Tests for src/git.ts — git/gh subprocess layer.
 * Written FIRST (TDD) — these fail until git.ts is implemented.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GitOpError,
  runCmd,
  isNetworkError,
  runWithRetry,
  git,
  gh,
  ghAuthEnv,
} from "../src/git.js";
import type { GhAuthContext } from "../src/types.js";

// ---------------------------------------------------------------------------
// GitOpError
// ---------------------------------------------------------------------------

describe("GitOpError", () => {
  it("is an Error subclass with name, stderr, and returncode", () => {
    const e = new GitOpError("test error", "some stderr", 2);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("GitOpError");
    expect(e.message).toBe("test error");
    expect(e.stderr).toBe("some stderr");
    expect(e.returncode).toBe(2);
  });

  it("defaults stderr to '' and returncode to 1", () => {
    const e = new GitOpError("msg");
    expect(e.stderr).toBe("");
    expect(e.returncode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runCmd
// ---------------------------------------------------------------------------

describe("runCmd", () => {
  it("resolves with code=0 and captured stdout on success", async () => {
    const result = await runCmd(["node", "-e", "process.stdout.write('hi')"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hi");
  });

  it("resolves with stderr captured on success", async () => {
    const result = await runCmd([
      "node",
      "-e",
      "process.stderr.write('warn'); process.stdout.write('ok')",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.stderr).toBe("warn");
  });

  it("throws GitOpError on non-zero exit when check=true (default)", async () => {
    await expect(
      runCmd(["node", "-e", "process.stderr.write('boom'); process.exit(3)"]),
    ).rejects.toMatchObject({
      name: "GitOpError",
      returncode: 3,
      stderr: "boom",
    });
  });

  it("resolves (no throw) on non-zero exit when check=false", async () => {
    const result = await runCmd(["node", "-e", "process.stderr.write('boom'); process.exit(3)"], {
      check: false,
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("boom");
  });

  it("throws GitOpError on timeout and includes 'timed out' in message", async () => {
    await expect(
      runCmd(["node", "-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 100 }),
    ).rejects.toMatchObject({ name: "GitOpError" });
    await expect(
      runCmd(["node", "-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 100 }),
    ).rejects.toThrow(/timed out/i);
  });
});

// ---------------------------------------------------------------------------
// isNetworkError
// ---------------------------------------------------------------------------

describe("isNetworkError", () => {
  it("matches 'dial tcp' substring", () => {
    expect(isNetworkError("error: dial tcp 8.8.8.8: i/o timeout")).toBe(true);
  });

  it("matches 'could not resolve host' case-insensitively", () => {
    expect(isNetworkError("Could Not Resolve Host: github.com")).toBe(true);
  });

  it("matches 'i/o timeout'", () => {
    expect(isNetworkError("read tcp: i/o timeout")).toBe(true);
  });

  it("matches 'connection refused'", () => {
    expect(isNetworkError("connection refused")).toBe(true);
  });

  it("matches 'couldn't connect to server'", () => {
    expect(isNetworkError("couldn't connect to server")).toBe(true);
  });

  it("matches 'error connecting to api.github.com'", () => {
    expect(isNetworkError("error connecting to api.github.com")).toBe(true);
  });

  it("matches 'network is unreachable'", () => {
    expect(isNetworkError("Network is unreachable")).toBe(true);
  });

  it("matches 'tls handshake timeout'", () => {
    expect(isNetworkError("TLS Handshake Timeout")).toBe(true);
  });

  it("matches 'failed to connect'", () => {
    expect(isNetworkError("failed to connect to server")).toBe(true);
  });

  it("matches 'operation timed out'", () => {
    expect(isNetworkError("Operation Timed Out")).toBe(true);
  });

  it("returns false for a non-network git error", () => {
    expect(isNetworkError("fatal: not a git repository")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isNetworkError("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runWithRetry
// ---------------------------------------------------------------------------

describe("runWithRetry", () => {
  it("resolves immediately when fn succeeds on first call", async () => {
    let calls = 0;
    const result = await runWithRetry("test", async () => {
      calls++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on network GitOpError and resolves after recovery", async () => {
    let calls = 0;
    const result = await runWithRetry(
      "test",
      async () => {
        calls++;
        if (calls < 3) {
          throw new GitOpError("git push failed", "dial tcp: i/o timeout", 1);
        }
        return "success";
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe("success");
    expect(calls).toBe(3);
  });

  it("rethrows immediately on non-network GitOpError (no retry)", async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        "test",
        async () => {
          calls++;
          throw new GitOpError("fatal: not a git repo", "fatal: not a git repo", 128);
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ name: "GitOpError", message: "fatal: not a git repo" });
    expect(calls).toBe(1);
  });

  it("rethrows immediately on non-GitOpError (no retry)", async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        "test",
        async () => {
          calls++;
          throw new TypeError("unexpected type");
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
  });

  it("throws last network error after exhausting all attempts (default 4)", async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        "test",
        async () => {
          calls++;
          throw new GitOpError("net fail", "connection refused", 1);
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ name: "GitOpError", message: "net fail" });
    expect(calls).toBe(4); // default attempts=4
  });

  it("respects custom attempts count", async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        "test",
        async () => {
          calls++;
          throw new GitOpError("net fail", "dial tcp", 1);
        },
        { attempts: 2, baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ name: "GitOpError" });
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// git / gh — argv assembly
// ---------------------------------------------------------------------------

describe("git", () => {
  it("uses cfg.gitBin as argv[0] and resolves stdout", async () => {
    const result = await git({ gitBin: "node" }, ["-e", "process.stdout.write('x')"]);
    expect(result.stdout).toBe("x");
    expect(result.code).toBe(0);
  });

  it("retries network errors when retryNetwork=true", async () => {
    // We can't easily make a real git call fail with network errors in tests,
    // so we verify the retryNetwork path doesn't blow up on success.
    const result = await git({ gitBin: "node" }, ["-e", "process.stdout.write('retry-ok')"], {
      retryNetwork: true,
    });
    expect(result.stdout).toBe("retry-ok");
  });
});

describe("gh", () => {
  it("uses cfg.ghBin as argv[0] and resolves stdout", async () => {
    const result = await gh({ ghBin: "node" }, ["-e", "process.stdout.write('y')"]);
    expect(result.stdout).toBe("y");
    expect(result.code).toBe(0);
  });

  it("retryNetwork path works on success", async () => {
    const result = await gh({ ghBin: "node" }, ["-e", "process.stdout.write('gh-retry-ok')"], {
      retryNetwork: true,
    });
    expect(result.stdout).toBe("gh-retry-ok");
  });
});

// ---------------------------------------------------------------------------
// bot auth env injection
// ---------------------------------------------------------------------------

const CTX: GhAuthContext = {
  configDir: "/sbx/junco-gh",
  login: "junco-agent",
  email: "1234+junco-agent@users.noreply.github.com",
  credentialHelper: "!gh auth git-credential",
};

function writeEnvEcho(path: string): void {
  writeFileSync(
    path,
    `#!/bin/sh\necho "cfgdir=\${GH_CONFIG_DIR:-unset} prompt=\${GIT_TERMINAL_PROMPT:-unset}"\necho "argv=$*"\n`,
    "utf8",
  );
  chmodSync(path, 0o755);
}

describe("bot auth env injection", () => {
  it("ghAuthEnv builds the child env pair", () => {
    expect(ghAuthEnv(CTX)).toEqual({
      GH_CONFIG_DIR: "/sbx/junco-gh",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("gh() injects GH_CONFIG_DIR when cfg carries ghAuth, not otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-git-test-"));
    const fake = join(dir, "fake-gh");
    writeEnvEcho(fake);
    const withAuth = await gh({ ghBin: fake, ghAuth: CTX }, ["api", "user"]);
    expect(withAuth.stdout).toContain("cfgdir=/sbx/junco-gh");
    expect(withAuth.stdout).toContain("prompt=0");
    const without = await gh({ ghBin: fake }, ["api", "user"]);
    expect(without.stdout).toContain("cfgdir=unset");
  });

  it("git() injects env AND pins the credential helper before the subcommand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-git-test-"));
    const fake = join(dir, "fake-git");
    writeEnvEcho(fake);
    const r = await git({ gitBin: fake, ghAuth: CTX }, ["push", "origin", "b"]);
    expect(r.stdout).toContain("cfgdir=/sbx/junco-gh");
    expect(r.stdout).toContain(
      "argv=-c credential.helper= -c credential.helper=!gh auth git-credential push origin b",
    );
    const plain = await git({ gitBin: fake }, ["push", "origin", "b"]);
    expect(plain.stdout).toContain("argv=push origin b");
  });
});
