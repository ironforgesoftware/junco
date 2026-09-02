/**
 * The canonical PR-flow script, shared by the run-once and daemon scenarios.
 *
 * The worker's three turns, then the critic's one. The critic (prFlow Phase 9,
 * src/critic.ts) is a SECOND model role that runs on every non-empty diff with
 * `tools: []` and looks for the `JUNCO_VERIFY: PASS|MISSING` marker — leaving
 * it at the production default is the point, so its turn is scripted too.
 */
import type { Turn } from "./stubModel.js";

export const HELLO = "hello from the e2e stub\n";

export const HAPPY_PATH_SCRIPT: Turn[] = [
  { kind: "tool", calls: [{ name: "write", args: { path: "hello.txt", content: HELLO } }] },
  {
    kind: "tool",
    calls: [{ name: "bash", args: { command: "git add -A && git commit -q -m 'add hello'" } }],
  },
  { kind: "text", text: "Done." },
  { kind: "text", text: "JUNCO_VERIFY: PASS" },
];

export const HAPPY_PATH_BODY = "# Add hello\n\nCreate `hello.txt` containing a greeting.\n";
