/**
 * `junco transcript <ticket-id | path.jsonl> | --chat <owner/repo | path> [--thinking] [--tools] [--width N] [--json]`
 * — prints a recorded per-ticket event transcript as the transcript viewer
 * renders it: run headers, turns, tool calls with result summaries (bodies
 * with --tools), the agent's text (thinking with --thinking). Target
 * resolution mirrors replayCmd.ts: a bare id resolves through the data tree
 * (config required); a literal path (ends in .jsonl or contains "/") reads
 * as-is, config optional. `--chat <key>` (spec 2026-09-01 §9) is a third,
 * mutually-exclusive mode — the KEY is the same one the dashboard's rail
 * uses (a watched "owner/repo" or a local checkout path); `chatSlug`
 * (chat/chatKey.ts) resolves it to <chats>/<slug>/transcript.jsonl, always
 * through the data tree (config required — there is no direct-path form for
 * chat transcripts, unlike the ticket-id branch above).
 */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type { Config } from "./types.js";
import { dataTreePaths } from "./dataTree.js";
import { transcriptPathForTarget, readTranscriptOrExplain } from "./transcriptTarget.js";
import { chatSlug } from "./chat/chatKey.js";
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
  "Usage: junco transcript <ticket-id | path.jsonl> | --chat <owner/repo | path> " +
  "[--thinking] [--tools] [--width N] [--json]";

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
        chat: { type: "string" },
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
  // parseArgs's loosely-typed `values` (ReturnType<typeof parseArgs> isn't
  // parameterized by the literal options object) types every value as
  // `string | boolean | (string | boolean)[]`; `chat` never declares
  // `multiple`, so a string is the only shape it ever actually takes.
  const chatKey = typeof values.chat === "string" ? values.chat : undefined;
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
  if (chatKey !== undefined) {
    // --chat takes no positional — the two target forms are mutually exclusive.
    if (target !== undefined) {
      deps.stdout(USAGE);
      return 2;
    }
    if (!cfg) {
      deps.stdout(
        `junco transcript: no config found — cannot resolve chat key '${chatKey}' to a ` +
          "transcript path",
      );
      return 1;
    }
    transcriptPath = join(dataTreePaths(cfg).chats, chatSlug(chatKey), "transcript.jsonl");
  } else if (target === undefined) {
    deps.stdout(USAGE);
    return 2;
  } else {
    const p = transcriptPathForTarget("transcript", target, cfg, deps.stdout);
    if (p === null) return 1;
    transcriptPath = p;
  }

  const content = readTranscriptOrExplain(
    "transcript",
    transcriptPath,
    cfg,
    deps.readFile,
    deps.stdout,
  );
  if (content === null) return 1;

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
