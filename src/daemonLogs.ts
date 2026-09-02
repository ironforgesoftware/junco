/**
 * Daemon-mode log plumbing, shared by the two commands that emit worker-log
 * output: `junco start` (startCmd.ts) and `junco run-once` (cli.ts). It lives
 * in its own module rather than in either of them so neither has to import the
 * other, and so `logging.ts` — which every module in the tree imports — stays
 * free of the config/dataTree graph this needs.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./types.js";
import {
  log,
  setLogFormat,
  setLogSink,
  openRotatingLogSink,
  openAppendLogSink,
} from "./logging.js";
import { dataTreePaths } from "./dataTree.js";

/**
 * Human format on a TTY (JUNCO_LOG_JSON=1 forces JSON), plus a JSON tee to the
 * state-dir worker.log. Returns a cleanup that detaches the sink and closes the
 * stream.
 *
 * `rotate` gates worker.log rotation, which is a SINGLE-WRITER concern (#76):
 * only the lock-holding daemon (`start`) rotates (10MB single-generation, at
 * open AND mid-run — see openRotatingLogSink). Non-daemon commands (`run-once`)
 * take no lock and may run against a live daemon's worker.log, so they append
 * WITHOUT rotating — a second rotating sink would rename the daemon's file aside
 * and lose lines.
 */
export function setupLogOutputs(cfg: Config, opts: { rotate: boolean }): () => void {
  if (process.stdout.isTTY && process.env.JUNCO_LOG_JSON !== "1") setLogFormat("human");
  if (!cfg.logToFile) return () => {};
  try {
    const logPath = dataTreePaths(cfg).logFile;
    mkdirSync(dirname(logPath), { recursive: true });
    const sink = opts.rotate ? openRotatingLogSink(logPath) : openAppendLogSink(logPath);
    setLogSink((l) => sink.write(l));
    return () => {
      setLogSink(null);
      sink.close();
    };
  } catch (e) {
    log.warn("file logging disabled (state dir not writable)", {
      error: e instanceof Error ? e.message : String(e),
    });
    return () => {};
  }
}
