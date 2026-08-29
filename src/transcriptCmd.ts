/**
 * `junco transcript <ticket-id | path.jsonl> [--thinking] [--tools] [--width N] [--json]`
 * — prints a recorded per-ticket event transcript as the transcript viewer
 * renders it: run headers, turns, tool calls with result summaries (bodies
 * with --tools), the agent's text (thinking with --thinking). Target
 * resolution mirrors replayCmd.ts: a bare id resolves through the data tree
 * (config required); a literal path (ends in .jsonl or contains "/") reads
 * as-is, config optional.
 */
import { parseArgs } from "node:util";
import type { Config } from "./types.js";
import { transcriptPathFor } from "./slug.js";
import { dataTreePaths } from "./dataTree.js";
import { summarizeTranscript, toolCallIds } from "./transcriptSummary.js";
import { renderTranscriptRows, MIN_WIDTH } from "./transcriptRender.js";

export interface TranscriptCmdDeps {
  /** May throw (no config on disk) — tolerated for a direct .jsonl target. */
  loadCfg: () => Config;
  /** Throws (e.g. ENOENT) when the path doesn't exist. */
  readFile: (path: string) => string;
  stdout: (line: string) => void;
  /** Terminal width for wrapping (cli.ts passes `process.stdout.columns ?? 100`). */
  columns: number;
}

const USAGE =
  "Usage: junco transcript <ticket-id | path.jsonl> [--thinking] [--tools] [--width N] [--json]";

function isPathLike(target: string): boolean {
  return target.endsWith(".jsonl") || target.includes("/");
}

export async function runTranscriptCmd(argv: string[], deps: TranscriptCmdDeps): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        thinking: { type: "boolean", default: false },
        tools: { type: "boolean", default: false },
        width: { type: "string" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    deps.stdout(e instanceof Error ? e.message : String(e));
    deps.stdout(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const target = positionals[0];
  if (!target) {
    deps.stdout(USAGE);
    return 2;
  }
  let width = deps.columns;
  if (values.width !== undefined) {
    width = Number(values.width);
    if (!Number.isInteger(width) || width < MIN_WIDTH) {
      deps.stdout(`junco transcript: --width must be an integer ≥ ${MIN_WIDTH}`);
      return 2;
    }
  }

  let cfg: Config | undefined;
  try {
    cfg = deps.loadCfg();
  } catch {
    cfg = undefined;
  }
  let transcriptPath: string;
  if (isPathLike(target)) {
    transcriptPath = target;
  } else {
    if (!cfg) {
      deps.stdout(
        `junco transcript: no config found — cannot resolve ticket id '${target}' to a transcript ` +
          "path; pass a direct .jsonl path instead",
      );
      return 1;
    }
    transcriptPath = transcriptPathFor(dataTreePaths(cfg).transcripts, target);
  }

  let content: string;
  try {
    content = deps.readFile(transcriptPath);
  } catch {
    const hint = cfg ? ` (transcripts dir: ${dataTreePaths(cfg).transcripts})` : "";
    deps.stdout(`junco transcript: no transcript at ${transcriptPath}${hint}`);
    return 1;
  }

  const summary = summarizeTranscript(content.split("\n"));
  if (values.json) {
    deps.stdout(JSON.stringify(summary, null, 2));
    return 0;
  }
  const rows = renderTranscriptRows(summary, {
    width,
    showThinking: values.thinking === true,
    expanded: new Set(values.tools === true ? toolCallIds(summary) : []),
  });
  for (const r of rows) deps.stdout(r.text);
  return 0;
}
