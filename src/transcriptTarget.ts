/**
 * How `junco replay` and `junco transcript` turn their positional target into
 * transcript text: a `.jsonl` path (or anything with a `/`) is read as-is; a
 * bare ticket id resolves through the config's transcripts dir. Shared so the
 * two commands cannot disagree about what counts as a path or how a missing
 * file is explained.
 */

import type { Config } from "./types.js";
import { transcriptPathFor } from "./slug.js";
import { dataTreePaths } from "./dataTree.js";

function isPathLike(target: string): boolean {
  return target.endsWith(".jsonl") || target.includes("/");
}

/** The transcript file for `target`, or null after printing why it cannot be
 * resolved (a bare id with no config to anchor the transcripts dir). */
export function transcriptPathForTarget(
  cmd: string,
  target: string,
  cfg: Config | undefined,
  stdout: (line: string) => void,
): string | null {
  if (isPathLike(target)) return target;
  if (!cfg) {
    stdout(
      `junco ${cmd}: no config found — cannot resolve ticket id '${target}' to a transcript ` +
        "path; pass a direct .jsonl path instead",
    );
    return null;
  }
  return transcriptPathFor(dataTreePaths(cfg).transcripts, target);
}

/** The transcript's text, or null after printing where it was looked for. */
export function readTranscriptOrExplain(
  cmd: string,
  transcriptPath: string,
  cfg: Config | undefined,
  readFile: (path: string) => string,
  stdout: (line: string) => void,
): string | null {
  try {
    return readFile(transcriptPath);
  } catch {
    const hint = cfg ? ` (transcripts dir: ${dataTreePaths(cfg).transcripts})` : "";
    stdout(`junco ${cmd}: no transcript at ${transcriptPath}${hint}`);
    return null;
  }
}
