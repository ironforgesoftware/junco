/**
 * Minimal env allowlist for untrusted child processes (verification blocks and
 * the sandboxed agent bash tool): shell/locale/tmp basics plus PATH+HOME (git
 * resolves binaries and ~/.gitconfig through them). Everything else — GH_TOKEN,
 * GITHUB_TOKEN, API-key-shaped vars — is dropped by construction because this
 * is an allowlist, not a denylist. (Extracted from verify.ts, #35.)
 */
export const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TMPDIR",
  "TERM",
  "TZ",
]);

/** Build the scrubbed child env: allowlisted names + every LC_* locale var. */
export function scrubEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && (ENV_ALLOWLIST.has(k) || k.startsWith("LC_"))) env[k] = v;
  }
  return env;
}
