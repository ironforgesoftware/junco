/**
 * `junco logs [-f] [-n N] [--json]` — read the state-dir worker.log; pretty by
 * default on a TTY, raw JSON with --json (or when piped). Follow mode polls
 * (fs.watch is unreliable across editors/filesystems) and survives rotation
 * (size shrink → reset to the file start).
 */

import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { formatHumanLine } from "./logging.js";

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
  const path = join(cfg.stateDir, "worker.log");
  if (!existsSync(path)) {
    print(
      `junco logs: no log file at ${path} (the daemon writes it once started; see [observability].state_dir)\n`,
    );
    return 1;
  }

  const tail = readFileSync(path, "utf8").split("\n").filter(Boolean);
  for (const l of tail.slice(-(opts.lines ?? 100))) print(render(l, json));
  if (!opts.follow) return 0;

  let pos = statSync(path).size;
  let carry = "";
  const pollMs = deps.pollMs ?? 500;
  return await new Promise<number>((resolveDone) => {
    const timer = setInterval(() => {
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        return; // rotated away mid-poll; next tick re-stats
      }
      if (size < pos) {
        pos = 0; // rotation: start over from the new file's head
        carry = "";
      }
      if (size > pos) {
        const fd = openSync(path, "r");
        try {
          const buf = Buffer.alloc(size - pos);
          readSync(fd, buf, 0, buf.length, pos);
          pos = size;
          const chunk = carry + buf.toString("utf8");
          const parts = chunk.split("\n");
          carry = parts.pop() ?? "";
          for (const l of parts.filter(Boolean)) print(render(l, json));
        } finally {
          closeSync(fd);
        }
      }
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
