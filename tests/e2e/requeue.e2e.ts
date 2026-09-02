import { describe, it, expect, afterEach } from "vitest";
import {
  createSandbox,
  queueState,
  remote,
  runOnce,
  stub,
  writeTicket,
  type Sandbox,
} from "./harness.js";

describe("e2e: transient provider failure", () => {
  let sb: Sandbox | null = null;
  afterEach(async () => {
    await sb?.close();
    sb = null;
  });

  it("transient-requeue: a sticky provider 503 requeues the ticket with retry_count and not_before", async () => {
    sb = await createSandbox({
      // Sticky: the SDK / openai client may retry a 5xx before surfacing it,
      // and each retry is a fresh request — an exhausted script would turn
      // this into a different failure. Retries are minimized via config so
      // the scenario stays fast; whatever the SDK still does, every attempt
      // sees the same 503.
      script: [{ kind: "error", status: 503, times: Infinity }],
      config: { model: { retry: { maxRetries: 0, baseDelayMs: 0 } } },
    });
    const id = "e2e-requeue";
    writeTicket(sb, {
      id,
      frontmatter: { repo: sb.git.work },
      body: "# Add hello\n\nCreate `hello.txt`.\n",
    });

    const before = Date.now();
    const r = await runOnce(sb);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(stub(sb).exhausted).toBe(false);
    expect(stub(sb).requests.length).toBeGreaterThan(0);

    // Back in inbox/ with the backoff stamp (src/requeue.ts:120-121), nothing pushed.
    const st = queueState(sb, id);
    expect(st.dir).toBe("inbox");
    expect(st.frontmatter.retry_count).toBe(1);
    expect(Date.parse(String(st.frontmatter.not_before))).toBeGreaterThan(before);
    expect(remote.branches(sb).filter((b) => b.startsWith("junco/"))).toEqual([]);
  });
});
