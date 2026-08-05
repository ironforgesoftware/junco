/**
 * Service-file renderer for the Junco node daemon.
 *
 * Produces:
 *  - macOS launchd LaunchAgent plist  (renderLaunchdPlist)
 *  - Linux systemd user unit          (renderSystemdUnit)
 *
 * Both targets encode the same semantics:
 *  - run `<nodeBin> <cliEntry> start` (config resolves from the environment: ~/.junco/config.json)
 *  - respawn on crash (non-zero exit), but NOT on a clean exit 0
 *    (important: the lock-held path exits 0, so the supervisor must not
 *     endlessly loop when another instance is already running)
 *  - minimum 30-second gap between respawn attempts (ThrottleInterval / RestartSec)
 *
 * Port / extension of the Python scripts/install.sh LaunchAgent stanza.
 */

import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ServiceOpts {
  /** launchd Label / systemd unit base name.
   *  Default: "com.junco.worker" (launchd) / unused in systemd header. */
  label?: string;
  /** Absolute node binary path. Default: process.execPath. */
  nodeBin?: string;
  /** Absolute path to the junco CLI entry (dist/cli.js). Required. */
  cliEntry: string;
  /** Dir for stdout/stderr log files (launchd). Default: join(home, ".junco"). */
  logDir?: string;
  /** HOME env value. Default: process.env.HOME ?? "". */
  home?: string;
  /** PATH env value. Default includes dirname(nodeBin) + common prefix dirs. */
  pathEnv?: string;
  /** Grace period (seconds) the supervisor allows between its stop signal and
   * SIGKILL. Must exceed the longest ticket timeout so a graceful shutdown can
   * drain the in-flight task instead of being killed mid-run (which would
   * orphan the ticket). Default 2400 (40 min — default 30-min ticket + margin). */
  stopTimeoutSeconds?: number;
}

// ---------------------------------------------------------------------------
// XML escaping (defensive — paths rarely contain these but spec says escape)
// ---------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Resolve defaults
// ---------------------------------------------------------------------------

function resolveOpts(opts: ServiceOpts): Required<ServiceOpts> {
  const nodeBin = opts.nodeBin ?? process.execPath;
  const home = opts.home ?? process.env.HOME ?? "";
  // launchd.out/err land under the junco home by default — next to the
  // canonical config, ahead of the single-root logs/ consolidation.
  const logDir = opts.logDir ?? join(home !== "" ? home : homedir(), ".junco");
  const nodeBinDir = dirname(nodeBin);
  const pathEnv = opts.pathEnv ?? `${nodeBinDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const label = opts.label ?? "com.junco.worker";
  const stopTimeoutSeconds = opts.stopTimeoutSeconds ?? 2400;
  return { label, nodeBin, cliEntry: opts.cliEntry, logDir, home, pathEnv, stopTimeoutSeconds };
}

// ---------------------------------------------------------------------------
// renderLaunchdPlist
// ---------------------------------------------------------------------------

export function renderLaunchdPlist(opts: ServiceOpts): string {
  const o = resolveOpts(opts);
  const x = xmlEscape;

  const stdOut = join(o.logDir, "launchd.out");
  const stdErr = join(o.logDir, "launchd.err");

  return `\
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${x(o.label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${x(o.nodeBin)}</string>
        <string>${x(o.cliEntry)}</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>ExitTimeOut</key><integer>${o.stopTimeoutSeconds}</integer>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>${x(stdOut)}</string>
    <key>StandardErrorPath</key><string>${x(stdErr)}</string>
    <key>EnvironmentVariables</key><dict>
        <key>HOME</key><string>${x(o.home)}</string>
        <key>PATH</key><string>${x(o.pathEnv)}</string>
    </dict>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// renderSystemdUnit
// ---------------------------------------------------------------------------

export function renderSystemdUnit(opts: ServiceOpts): string {
  const o = resolveOpts(opts);

  // systemd unit lines are INI-style, not XML — no XML escaping. systemd splits
  // ExecStart on unquoted whitespace, so every interpolated value (the node
  // binary and the CLI entry — both user-controlled) is double-quoted; a path
  // like "/opt/junco app/dist/cli.js" then survives as a single argument
  // instead of two. systemd also honors "..." quoting in Environment= values.
  // Backslashes and embedded double-quotes are escaped so the quoting can't
  // be broken out of. (#43)
  //
  // Escaping $ and % differs by field because systemd's expansion rules do (#79):
  //  - ExecStart words undergo BOTH environment-variable ($VAR/${VAR}) AND
  //    specifier (%X) expansion — even inside double quotes; only $$ and %% are
  //    literals. So a path with $ or % must double both or it is mangled/emptied
  //    at unit load.
  //  - Environment= values undergo specifier (%) expansion but NOT variable
  //    expansion ("the $ character has no special meaning" — systemd.exec(5)).
  //    So % must be doubled there, but $ must be left single — doubling it would
  //    corrupt the value into a literal "$$".
  const escBase = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const qExec = (s: string): string => `"${escBase(s).replace(/\$/g, "$$$$").replace(/%/g, "%%")}"`;
  const qEnv = (s: string): string => `"${escBase(s).replace(/%/g, "%%")}"`;
  return `\
[Unit]
Description=Junco task-queue worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${qExec(o.nodeBin)} ${qExec(o.cliEntry)} start
Restart=on-failure
RestartSec=30
TimeoutStopSec=${o.stopTimeoutSeconds}
Environment=HOME=${qEnv(o.home)}
Environment=PATH=${qEnv(o.pathEnv)}

[Install]
WantedBy=default.target
`;
}

// ---------------------------------------------------------------------------
// renderService — dispatch
// ---------------------------------------------------------------------------

export function renderService(platform: "launchd" | "systemd", opts: ServiceOpts): string {
  if (platform === "launchd") return renderLaunchdPlist(opts);
  return renderSystemdUnit(opts);
}
