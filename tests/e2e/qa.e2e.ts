import { describe, it, expect, afterEach } from "vitest";
import {
  chatRequests,
  createSandbox,
  queueState,
  remote,
  runOnce,
  stub,
  writeTicket,
  type Sandbox,
} from "./harness.js";

describe("e2e: Q&A flow", () => {
  let sb: Sandbox | null = null;
  afterEach(async () => {
    await sb?.close();
    sb = null;
  });

  it("qa-read-only: a repo-less ticket is answered, and the model is offered only read-only tools", async () => {
    sb = await createSandbox({ script: [{ kind: "text", text: "The answer is forty-two." }] });
    const id = "e2e-qa";
    writeTicket(sb, { id, body: "# Question\n\nWhat is the answer?\n" });

    const r = await runOnce(sb);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(stub(sb).exhausted).toBe(false);

    // Finalized with the answer appended as the `## Result` section (src/finalize.ts:33).
    const st = queueState(sb, id);
    expect(st.dir).toBe("done");
    expect(st.body).toContain("## Result");
    expect(st.body).toContain("The answer is forty-two.");

    // The hard rule (CLAUDE.md): Q&A tickets default to the read-only subset — proven at the wire.
    const reqs = chatRequests(sb);
    expect(reqs).toHaveLength(1);
    const tools = (reqs[0].body?.tools ?? []) as Array<{ function: { name: string } }>;
    expect(tools.map((t) => t.function.name).sort()).toEqual(["find", "grep", "ls", "read"]);

    // Nothing touched git.
    expect(remote.branches(sb)).toEqual(["main"]);
  });
});
