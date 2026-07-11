import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectBackend, defaultExecProbe } from "../src/agent/sandbox/backend.js";
import { buildPolicy } from "../src/agent/sandbox/policy.js";
import { makeSandboxedBashOperations } from "../src/agent/sandbox/bashOps.js";

// Ground-truth enforcement: actually run bash under the real OS sandbox. Skipped
// when the backend binary is unavailable (e.g. bwrap without userns on a CI
// runner) so unit CI stays green everywhere; do NOT weaken the assertions to
// make them pass unsandboxed — a real enforcement failure must fail this suite.
const backend = selectBackend("auto", process.platform);
let available = false;
beforeAll(async () => {
  available = backend.name !== "none" && (await backend.isAvailable(defaultExecProbe));
});

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run one command under the sandbox; return exit code + combined output. */
async function run(
  command: string,
  opts: { work: string; scratch: string; network?: boolean; extraDeny?: string[] },
): Promise<{ code: number | null; out: string }> {
  const policy = buildPolicy({
    cfg: {
      enabled: true,
      backend: "auto",
      network: "deny",
      extraDenyRead: opts.extraDeny ?? [],
      extraAllowWrite: [],
    },
    cwd: opts.work,
    scratchDir: opts.scratch,
    home: process.env.HOME ?? "/tmp",
    stateDir: join(opts.scratch, "state"),
    network: opts.network ?? false,
  });
  // Inject a fake GH_TOKEN into the source env to prove the scrub removes it.
  const ops = makeSandboxedBashOperations(backend, policy, {
    env: () => ({ ...process.env, GH_TOKEN: "SECRET_TOKEN_VALUE" }),
  });
  let out = "";
  const res = await ops.exec(command, opts.work, { onData: (d) => (out += d.toString()) });
  return { code: res.exitCode, out };
}

describe("sandbox integration (real OS enforcement)", () => {
  it("write inside the worktree succeeds", async () => {
    if (!available) return;
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    const r = await run(`echo ok > "${work}/inside.txt"`, { work, scratch });
    expect(r.code).toBe(0);
    expect(existsSync(join(work, "inside.txt"))).toBe(true);
  });

  it("write outside the worktree fails", async () => {
    if (!available) return;
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    const outside = tmp("junco-it-out-");
    const r = await run(`echo no > "${outside}/x.txt" 2>&1; echo "exit=$?"`, { work, scratch });
    expect(r.out).toMatch(/exit=[^0]/);
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
  });

  it("the child env has no GH_TOKEN (credential scrub)", async () => {
    if (!available) return;
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    const r = await run(`echo "TOKEN=[\${GH_TOKEN:-absent}]"`, { work, scratch });
    expect(r.out).toContain("TOKEN=[absent]");
  });

  it("network egress fails when denied", async () => {
    if (!available) return;
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    const r = await run(`exec 3<>/dev/tcp/1.1.1.1/80 2>&1; echo "exit=$?"`, {
      work,
      scratch,
      network: false,
    });
    expect(r.out).toMatch(/exit=[^0]/);
  });

  it("reading a denied secret path fails while an allowed read succeeds", async () => {
    if (!available) return;
    const work = tmp("junco-it-work-");
    const scratch = tmp("junco-it-scratch-");
    const secretDir = tmp("junco-it-secret-");
    writeFileSync(join(secretDir, "creds"), "TOPSECRET");
    writeFileSync(join(work, "public.txt"), "PUBLIC");
    const r = await run(`cat "${work}/public.txt"; cat "${secretDir}/creds" 2>&1; echo "exit=$?"`, {
      work,
      scratch,
      extraDeny: [secretDir],
    });
    expect(r.out).toContain("PUBLIC");
    expect(r.out).not.toContain("TOPSECRET");
    expect(r.out).toMatch(/exit=[^0]/);
  });
});
