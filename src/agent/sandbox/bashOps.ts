import { spawn as realSpawn } from "node:child_process";
import { scrubEnv } from "../../scrubEnv.js";
import type { SandboxBackend } from "./backend.js";
import type { SandboxPolicy } from "./policy.js";

/** Node clamps a `setTimeout` delay above 2^31-1 ms to 1 ms (with a
 *  TimeoutOverflowWarning) — an "effectively unlimited" value would kill
 *  every command instantly. Same cap Pi's own backend enforces. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** After a reap, how long to wait for `close` before settling on `exit`
 *  alone — a group-escaping descendant can keep the stdio pipes open. */
const REAP_SETTLE_GRACE_MS = 100;

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
      // default ceiling (ms; undefined = none), clamped to MAX_TIMEOUT_MS so an
      // "unlimited" value can't overflow Node's setTimeout and fire after 1 ms.
      // Both reap the whole process group and REJECT with the exact errors Pi's
      // own backend throws (abort takes precedence over a timer that also fired
      // — Pi checks `signal.aborted` first), so the tool renders "Command timed
      // out after N seconds" / "Command aborted" instead of treating the killed
      // child's null exit code as success. Once reaped, settling still prefers
      // `close`, but falls back to `exit` plus a short grace if a process-group-
      // escaping descendant keeps the stdio pipes open and `close` never fires.
      // Pi validates `timeout` (> 0) only inside its own local backend; a custom
      // BashOperations receives the raw model value. 0/negative/NaN would otherwise
      // slip past the timer guard and run with NO ceiling — treat them as absent.
      const explicitMs =
        typeof options.timeout === "number" &&
        Number.isFinite(options.timeout) &&
        options.timeout > 0
          ? options.timeout * 1000
          : undefined;
      const rawLimitMs = explicitMs ?? policy.bashTimeoutMs;
      const limitMs = rawLimitMs === undefined ? undefined : Math.min(rawLimitMs, MAX_TIMEOUT_MS);
      const limitSecs = limitMs === undefined ? undefined : Math.max(1, Math.round(limitMs / 1000));

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
        let graceTimer: NodeJS.Timeout | undefined;
        const finish = (exitCode: number | null): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (graceTimer) clearTimeout(graceTimer);
          if (options.signal) options.signal.removeEventListener("abort", onAbort);
          reap(); // sweep any surviving group members before settling
          if (aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${limitSecs}`));
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

        // A reaped child can exit while an escaped descendant (setsid, a
        // daemonizer) keeps the inherited stdio pipes open, so `close` never
        // fires. Mirror Pi's backend: once we have decided to kill, settle on
        // `exit` after a short grace if `close` has not arrived.
        proc.on("exit", (code: number | null) => {
          if (!(timedOut || aborted) || settled) return;
          graceTimer = setTimeout(() => finish(code), REAP_SETTLE_GRACE_MS);
        });
      });
    },
  };
}
