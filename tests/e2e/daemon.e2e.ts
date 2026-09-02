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
      { timeoutMs: 30_000, label: "/health responds" },
    );
    const body = (await (await fetch(health)).json()) as { status: string };
    expect(body.status).toBe("ok");

    const id = "e2e-daemon";
    writeTicket(sb, { id, frontmatter: { repo: sb.git.work }, body: HAPPY_PATH_BODY });
    const sandbox = sb;
    await waitFor(() => queueState(sandbox, id).dir === "done", {
      timeoutMs: 90_000,
      label: "ticket reaches done/",
    });

    daemon.child.kill("SIGTERM");
    const r = await daemon.exited;
    expect(r.code).toBe(0);
    await expect(fetch(health)).rejects.toThrow();

    expect(remote.branches(sb).filter((b) => b.startsWith("junco/"))).toHaveLength(1);
  });
});
