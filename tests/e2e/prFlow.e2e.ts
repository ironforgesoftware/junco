import { describe, it, expect, afterEach } from "vitest";
import {
  chatRequests,
  createSandbox,
  ghLog,
  queueState,
  remote,
  runOnce,
  stub,
  transcript,
  writeTicket,
  type Sandbox,
} from "./harness.js";
import { HAPPY_PATH_BODY, HAPPY_PATH_SCRIPT, HELLO } from "./happyPath.js";

describe("e2e: PR flow", () => {
  let sb: Sandbox | null = null;
  afterEach(async () => {
    await sb?.close();
    sb = null;
  });

  it("pr-happy-path: a ticket becomes a branch, a commit, and a PR through the real CLI and SDK", async () => {
    sb = await createSandbox({ script: HAPPY_PATH_SCRIPT });
    const id = "e2e-pr-happy";
    writeTicket(sb, { id, frontmatter: { repo: sb.git.work }, body: HAPPY_PATH_BODY });

    const r = await runOnce(sb);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(stub(sb).exhausted).toBe(false);

    // Queue: finalized.
    expect(queueState(sb, id).dir).toBe("done");

    // Git: exactly one junco/* branch on the BARE remote, one commit ahead of main, carrying the file.
    const branches = remote.branches(sb).filter((b) => b.startsWith("junco/"));
    expect(branches).toHaveLength(1);
    const branch = branches[0];
    expect(remote.ahead(sb, branch)).toBe(1);
    expect(remote.log(sb, branch)[0]).toBe("add hello");
    expect(remote.show(sb, branch, "hello.txt")).toBe(HELLO);

    // gh: one PR opened against main from that branch.
    const creates = ghLog(sb).filter((l) => l.startsWith("pr create "));
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain("--base main");
    expect(creates[0]).toContain(`--head ${branch}`);

    // Wire: the ticket body reached the model; the critic's request carried no tools.
    const reqs = chatRequests(sb);
    expect(reqs).toHaveLength(HAPPY_PATH_SCRIPT.length);
    expect(JSON.stringify(reqs[0].body?.messages)).toContain("Create `hello.txt`");
    expect(reqs.at(-1)?.body?.tools ?? []).toEqual([]);

    // Transcript: both tool executions recorded; the run ended without error.
    const lines = transcript(sb, id);
    const toolStarts = lines
      .filter((l) => l.kind === "sdk" && l.event.type === "tool_execution_start")
      .map((l) => (l.kind === "sdk" ? String(l.event.toolName) : ""));
    expect(toolStarts).toEqual(["write", "bash"]);
    const runEnd = lines.find((l) => l.kind === "junco" && l.record.type === "junco_run_end");
    expect(
      runEnd?.kind === "junco" && runEnd.record.type === "junco_run_end"
        ? runEnd.record.errorMessage
        : "missing",
    ).toBeNull();
  });
});
