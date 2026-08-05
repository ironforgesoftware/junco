/**
 * `junco logs [-f] [-n N] [--json]` — read the state-dir worker.log; pretty by
 * default on a TTY, raw JSON with --json (or when piped). Follow mode polls
 * (fs.watch is unreliable across editors/filesystems) and survives rotation
 * (size shrink → reset to the file start).
 */

import { existsSync } from "node:fs";
import type { Config } from "./types.js";
import { formatHumanLine } from "./logging.js";
import { readTail, makeLogTailer } from "./logReader.js";
import { dataTreePaths } from "./dataTree.js";

export interface LogsOpts {
  follow?: boolean;
  lines?: number;
  json?: boolean;
}

export interface LogsDeps {
  printFn?: (s: string) => void;
  pollMs?: number;
  /** Follow-mode stop signal (tests; the CLI wires SIGINT). */
  signal?: AbortSignal;
}

function render(rawLine: string, json: boolean): string {
  if (json) return rawLine + "\n";
  try {
    return formatHumanLine(JSON.parse(rawLine) as Record<string, unknown>) + "\n";
  } catch {
    return rawLine + "\n"; // non-JSON line (crash output etc.) — pass through
  }
}

export async function runLogsCommand(
  cfg: Config,
  opts: LogsOpts = {},
  deps: LogsDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const json = opts.json ?? !process.stdout.isTTY;
  const path = dataTreePaths(cfg).logFile;
  if (!existsSync(path)) {
    print(
      `junco logs: no log file at ${path} (the daemon writes it once started; see dataDir in docs/configuration.md)\n`,
    );
    return 1;
  }

  const tail = readTail(path, opts.lines ?? 100);
  for (const e of tail) print(render(e.raw, json));
  if (!opts.follow) return 0;

  const tailer = makeLogTailer(path);
  const pollMs = deps.pollMs ?? 500;
  return await new Promise<number>((resolveDone) => {
    const timer = setInterval(() => {
      for (const e of tailer.poll()) print(render(e.raw, json));
    }, pollMs);
    const stop = (): void => {
      clearInterval(timer);
      resolveDone(0);
    };
    if (deps.signal) {
      if (deps.signal.aborted) stop();
      else deps.signal.addEventListener("abort", stop, { once: true });
    } else {
      process.once("SIGINT", stop);
    }
  });
}
