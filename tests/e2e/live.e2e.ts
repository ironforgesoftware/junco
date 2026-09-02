/**
 * The real-model layer. Inert unless JUNCO_E2E_LIVE=1 (npm run test:e2e:live
 * sets it). Outcome-only assertions: model behavior legitimately varies, so
 * nothing here looks at turn counts or transcript shape.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  createSandbox,
  queueState,
  remote,
  runOnce,
  writeTicket,
  type Sandbox,
} from "./harness.js";

const LIVE = process.env.JUNCO_E2E_LIVE === "1";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required when JUNCO_E2E_LIVE=1`);
  return v;
}

describe.skipIf(!LIVE)("e2e: live model", () => {
  let sb: Sandbox | null = null;
  afterEach(async () => {
    await sb?.close();
    sb = null;
  });

  it("live-pr: a real model turns a toy ticket into a PR", async () => {
    sb = await createSandbox({
      model: {
        id: need("JUNCO_E2E_MODEL_ID"),
        baseUrl: need("JUNCO_E2E_BASE_URL"),
        apiKey: process.env.JUNCO_E2E_API_KEY ?? "none",
      },
    });
    const id = "e2e-live";
    writeTicket(sb, {
      id,
      frontmatter: { repo: sb.git.work },
      body:
        "# Add hello\n\n" +
        "Create a file `hello.txt` at the repository root containing exactly the text `hello` " +
        "followed by a newline. Commit it with the message `add hello`. Do nothing else.\n",
    });

    const r = await runOnce(sb, { timeoutMs: 600_000 });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(queueState(sb, id).dir).toBe("done");

    const branches = remote.branches(sb).filter((b) => b.startsWith("junco/"));
    expect(branches).toHaveLength(1);
    expect(remote.show(sb, branches[0], "hello.txt").trim()).toBe("hello");
  }, 660_000);
});
