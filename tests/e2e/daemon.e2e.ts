import { existsSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import {
  createSandbox,
  queueState,
  remote,
  spawnDaemon,
  waitFor,
  writeTicket,
  type DaemonHandle,
  type Sandbox,
} from "./harness.js";
import { HAPPY_PATH_BODY, HAPPY_PATH_SCRIPT } from "./happyPath.js";
import { workerLockPath } from "../../src/lock.js";

describe("e2e: daemon lifecycle", () => {
  let sb: Sandbox | null = null;
  let daemon: DaemonHandle | null = null;
  afterEach(async () => {
    if (daemon && daemon.child.exitCode === null) daemon.child.kill("SIGKILL");
    daemon = null;
    await sb?.close();
    sb = null;
  });

  it("daemon-lifecycle: start serves /health, drains a ticket, and exits cleanly on SIGTERM", async () => {
    sb = await createSandbox({
      script: HAPPY_PATH_SCRIPT,
      config: { worker: { pollIntervalSeconds: 1 } },
    });
    const health = `http://127.0.0.1:${sb.healthPort}/health`;

    daemon = spawnDaemon(sb);
    await waitFor(
      async () => {
        try {
          return (await fetch(health)).ok;
        } catch {
          return false;
        }
      },
      { timeoutMs: 20_000, label: "/health responds" },
    );
    const body = (await (await fetch(health)).json()) as { status: string };
    expect(body.status).toBe("ok");

    // The singleton lock's pidfile (spec §6.4): must exist while the daemon is
    // up (proves the assertion below is not vacuous) and be gone after it
    // exits.
    const lockPath = workerLockPath(sb.configPath);
    expect(existsSync(lockPath)).toBe(true);

    const id = "e2e-daemon";
    writeTicket(sb, { id, frontmatter: { repo: sb.git.work }, body: HAPPY_PATH_BODY });
    const sandbox = sb;
    await waitFor(() => queueState(sandbox, id).dir === "done", {
      timeoutMs: 80_000,
      label: "ticket reaches done/",
    });

    daemon.child.kill("SIGTERM");
    const r = await daemon.exited;
    expect(r.code).toBe(0);
    await expect(fetch(health)).rejects.toThrow();
    expect(existsSync(lockPath)).toBe(false);

    expect(remote.branches(sb).filter((b) => b.startsWith("junco/"))).toHaveLength(1);
  });
});
