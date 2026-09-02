// The config module's three jobs, split into one file each (#358), re-exported
// here so `./config.js` stays the single import site for all of them:
//
//   configPaths.ts    — HOME/XDG resolution and the data-tree layout probes
//   configSchema.ts   — the zod ConfigSchema (nested config.json shape) + parse
//   configAssemble.ts — schema output → the flat runtime `Config`
//
// Only the two helpers below, which belong to none of the three, still live
// here.
export {
  type DataRootResolution,
  type KnownQueueRoot,
  type ResolveConfigDeps,
  configPathOverride,
  dataRootHasTree,
  defaultUserConfigPath,
  expandHome,
  homeOf,
  juncoHome,
  knownQueueRoots,
  layoutOf,
  legacyConfigPath,
  queuePaths,
  resolveBotGhConfigDir,
  resolveConfigPath,
  resolveDataRoot,
} from "./configPaths.js";
export {
  type ConfigParsed,
  ConfigSchema,
  parseConfigFile,
  validateConfigObject,
} from "./configSchema.js";
export { assembleConfig, configDeprecations, loadConfig, resolveApiKey } from "./configAssemble.js";

/** AbortController timeout (ms) for a single GET to the daemon's `/health`
 * endpoint — shared by the dashboard snapshots (queueSnapshot + localSnapshot)
 * and `junco worktree prune`'s currentTickets probe so the three agree. */
export const HEALTH_TIMEOUT_MS = 1500;

/**
 * True when `host` is a loopback bind address — 127.0.0.0/8, ::1 (optionally
 * bracketed), or the literal "localhost". A non-loopback healthHost (e.g.
 * "0.0.0.0" or a LAN IP) exposes the unauthenticated /health metrics to the
 * network, so daemon startup and `junco doctor` warn on it (#44). Empty/unknown
 * strings are treated as non-loopback (fail safe → warn).
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost") return true;
  // Strip IPv6 brackets: [::1] → ::1
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (bare === "::1") return true;
  // IPv4 127.0.0.0/8 — any address whose first octet is 127.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (m) {
    const octets = m.slice(1, 5).map(Number);
    if (octets.every((o) => o <= 255) && octets[0] === 127) return true;
  }
  return false;
}
