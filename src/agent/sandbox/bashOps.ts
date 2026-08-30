import { spawn as realSpawn } from "node:child_process";
import { scrubEnv } from "../../scrubEnv.js";
import type { SandboxBackend } from "./backend.js";
import type { SandboxPolicy } from "./policy.js";

/** Structural mirror of the SDK's BashOperations.exec options (no SDK import). */
export interface BashExecOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  /** SECONDS — the model's raw `timeout` argument. Pi's own local backend
   *  converts to ms itself (bash.js resolveTimeoutMs); a custom
   *  BashOperations receives the schema value untouched. */
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

/** Structural mirror of the SDK's BashOperations interface. */
export interface BashOperationsLike {
  exec: (
    command: string,
    cwd: string,
    options: BashExecOptions,
  ) => Promise<{ exitCode: number | null }>;
}

export interface BashOpsDeps {
  spawnFn?: typeof realSpawn;
  /** Source env before scrubbing; defaults to process.env. Injectable for tests. */
  env?: () => Record<string, string | undefined>;
  /** Process-group kill seam (defaults to process.kill). Injectable so the
   *  reap can be asserted without signalling a real pid in tests. */
  killFn?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Build a BashOperations that runs the model's command under the OS sandbox
 * backend with a scrubbed env (no GH_TOKEN / API keys) and TMPDIR redirected to
 * the per-session scratch dir. Ignores any caller-supplied env — the scrubbed
 * env is built fresh so credential containment never depends on the caller.
 */
export function makeSandboxedBashOperations(
  backend: SandboxBackend,
  policy: SandboxPolicy,
  deps: BashOpsDeps = {},
): BashOperationsLike {
  const spawnFn = deps.spawnFn ?? realSpawn;
  const envSource = deps.env ?? (() => process.env);
  const killFn =
    deps.killFn ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));

  return {
    exec(command, cwd, options) {
      const [bin, ...args] = backend.spawnArgv(command, policy);
      const env = { ...scrubEnv(envSource()), TMPDIR: policy.scratchDir };

      // The agent's explicit timeout (seconds) wins; otherwise the policy's
      // default ceiling (ms; undefined = none). Both reap the whole process
      // group and REJECT with the exact errors Pi's own backend throws, so the
      // tool renders "Command timed out after N seconds" / "Command aborted"
      // instead of treating the killed child's null exit code as success.
      const limitMs = options.timeout !== undefined ? options.timeout * 1000 : policy.bashTimeoutMs;
      const limitSecs = limitMs === undefined ? undefined : Math.round(limitMs / 1000);

      return new Promise<{ exitCode: number | null }>((resolve, reject) => {
        // detached → own process group, so `kill(-pid)` reaps the whole group.
        const proc = spawnFn(bin, args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env,
          detached: true,
        });

        // Kill the whole process GROUP (negative pid) so a backgrounded child
        // (`ln -s … &`) can't survive this bash call to race the fs-tool path
        // jail (#159). On Linux, bwrap's --unshare-pid/--die-with-parent already
        // reap the namespace; this covers seatbelt/none on macOS. Residual: a
        // setsid-escaping child on macOS survives — closed only by the native
        // *at resolver (deferred, #159).
        const reap = (): void => {
          if (proc.pid !== undefined) {
            try {
              killFn(-proc.pid, "SIGKILL");
              return;
            } catch {
              /* group already gone */
            }
          }
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        };

        let settled = false;
        let timedOut = false;
        let aborted = false;
        const finish = (exitCode: number | null): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (options.signal) options.signal.removeEventListener("abort", onAbort);
          reap(); // sweep any surviving group members before settling
          if (timedOut) reject(new Error(`timeout:${limitSecs}`));
          else if (aborted) reject(new Error("aborted"));
          else resolve({ exitCode });
        };

        proc.stdout?.on("data", (c: Buffer) => options.onData(c));
        proc.stderr?.on("data", (c: Buffer) => options.onData(c));

        const timer =
          limitMs !== undefined && limitMs > 0
            ? setTimeout(() => {
                timedOut = true;
                reap();
              }, limitMs)
            : undefined;

        const onAbort = (): void => {
          aborted = true;
          reap();
        };
        if (options.signal) {
          if (options.signal.aborted) onAbort();
          else options.signal.addEventListener("abort", onAbort);
        }

        proc.on("error", () => finish(null));
        proc.on("close", (code: number | null) => finish(code));
      });
    },
  };
}
