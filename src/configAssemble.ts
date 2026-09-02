import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { catalogEligible } from "./agent/modelSetup.js";
import { expandHome, resolveBotGhConfigDir, resolveDataRoot } from "./configPaths.js";
import { type ConfigParsed, parseConfigFile } from "./configSchema.js";

// junco's previously-hardcoded compat block (src/agent/session.ts), now the
// default. The SDK and the config file both use camelCase — no camelization.
//
// thinkingFormat is the GENERIC "chat-template" (kwargs declared below), not
// the SDK's fixed "qwen-chat-template" branch: that branch emits only
// enable_thinking/preserve_thinking and never forwards reasoning_effort, so on
// templates that steer thinking depth through a reasoning_effort kwarg
// (Qwen 3.8+) every configured thinkingLevel silently ran at the template
// default. SDK reference: @earendil-works/pi-ai dist/api/openai-completions.js,
// buildChatTemplateKwargs/resolveChatTemplateKwargValue.
const DEFAULT_COMPAT: Record<string, unknown> = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
  supportsUsageInStreaming: true,
  thinkingFormat: "chat-template",
  chatTemplateKwargs: {
    enable_thinking: { $var: "thinking.enabled" },
    preserve_thinking: true,
    // Resolved through model.thinkingLevelMap; dropped when thinking is off.
    reasoning_effort: { omitWhenOff: true },
  },
};

const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:1234/v1";

const ENV_REF = /^\$([A-Z_][A-Z0-9_]*)$/;

/**
 * Resolve the configured model.apiKey: a literal passes through; an exact
 * "$ENV_VAR" reference (uppercase env style only — anything else is a literal)
 * is read from the daemon environment; absent stays null so the SDK's
 * request-time provider env-var fallback (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * …) applies. "!command" values are rejected: the Pi SDK shell-executes them
 * in its own auth files, and junco will not forward that surface from
 * config.json.
 */
export function resolveApiKey(
  raw: string | undefined,
  env: Record<string, string | undefined>,
): string | null {
  if (raw === undefined) return null;
  if (raw.startsWith("!")) {
    throw new Error(
      'config: model.apiKey must not be a "!command" value — junco does not execute shell ' +
        'commands from config.json. Use a literal key or an "$ENV_VAR" reference.',
    );
  }
  const m = ENV_REF.exec(raw);
  if (m) {
    const val = env[m[1]];
    if (val === undefined || val === "") {
      throw new Error(
        `config: model.apiKey references $${m[1]}, but ${m[1]} is not set in the daemon environment.`,
      );
    }
    return val;
  }
  return raw;
}

/** Assemble the flat runtime `Config` from the parsed (nested, camelCase,
 * defaulted) schema output — expanding `~` in path fields and deriving the
 * github cross-field defaults (askLabel, externalReposRoot).
 *
 * The nested-path → flat-key rename map this function spells out by hand is
 * machine-checked by `tests/configLevers.test.ts` (#358): it perturbs each
 * schema leaf, re-runs this assembly, and pins which flat keys moved. */
export function assembleConfig(
  d: ConfigParsed,
  env: Record<string, string | undefined> = process.env,
  deps: { existsFn?: (p: string) => boolean } = {},
): Config {
  const baseUrlExplicit = d.model.baseUrl !== undefined;
  const eligible = catalogEligible({ source: d.model.source, id: d.model.id, baseUrlExplicit });
  const resolvedKey = resolveApiKey(d.model.apiKey, env);
  // Unified data root (spec 2026-07-16): legacy observability.stateDir wins
  // over dataDir for the whole root; legacy vaultRoot/juncoSubdir wins the
  // queue root only. See LegacyPathFlags for which override each key drives.
  //
  // #198: normalize the four legacy path keys once — an explicitly-set-but-empty
  // (or whitespace-only) value is treated as unset, so the legacy FLAG and the
  // RESOLUTION can never disagree (an empty "vaultRoot": "" previously set the
  // flag true — deprecation warning, provenance suffix, overlay pinning — while
  // the resolution fell through to the dataDir default).
  const norm = (v: string | undefined): string | undefined =>
    v !== undefined && v.trim() !== "" ? v : undefined;
  const nStateDir = norm(d.observability.stateDir);
  const nVault = norm(d.vaultRoot);
  const nWorktree = norm(d.git.worktreeRoot);
  const nExternal = norm(d.github.externalReposRoot);
  const existsFn = deps.existsFn ?? existsSync;
  // Single-root ~/.junco: see resolveDataRoot's doc comment for the full
  // fallback rationale.
  const explicitRoot = nStateDir ?? d.dataDir;
  const { dataDir, dataLayout, legacyDataRoot } = resolveDataRoot(explicitRoot, env, existsFn);
  const queueRoot = nVault ? join(expandHome(nVault), d.juncoSubdir) : join(dataDir, "queue");
  // Bot gh config dir: same single-root move as dataDir above, but resolved
  // through the shared resolveBotGhConfigDir (authCmd.ts/wizard.ts call the
  // same function so all three entrypoints agree — see its doc comment).
  const { dir: ghConfigDir, legacy: legacyGhDir } = resolveBotGhConfigDir(
    d.botAccount.configDir,
    env,
    existsFn,
  );
  const legacy = {
    vaultRoot: nVault !== undefined,
    stateDir: nStateDir !== undefined,
    worktreeRoot: nWorktree !== undefined,
    externalReposRoot: nExternal !== undefined,
    dataRoot: legacyDataRoot,
    ghConfigDir: legacyGhDir,
  };
  return {
    dataDir,
    dataLayout,
    queueRoot,
    legacy,
    updateCheck: d.updateCheck,
    tools: d.tools,
    model: {
      id: d.model.id,
      source: d.model.source,
      modelsJson: d.model.modelsJson ? expandHome(d.model.modelsJson) : null,
      api: d.model.api,
      // Stored raw; apiBaseUrl() normalizes (strips trailing /models) at use.
      baseUrl: d.model.baseUrl ?? DEFAULT_LOCAL_BASE_URL,
      baseUrlExplicit,
      // Catalog-eligible configs may omit the key: the SDK falls back to the
      // provider's env var (ANTHROPIC_API_KEY, …) at request time. The "1234"
      // placeholder applies only to inline/local endpoints.
      apiKey: resolvedKey ?? (eligible ? null : "1234"),
      retry: {
        maxRetries: d.model.retry.maxRetries ?? null,
        baseDelayMs: d.model.retry.baseDelayMs ?? null,
      },
      reasoning: d.model.reasoning,
      input: d.model.input,
      contextWindow: d.model.contextWindow,
      maxTokens: d.model.maxTokens,
      cost: {
        input: d.model.cost.input,
        output: d.model.cost.output,
        cacheRead: d.model.cost.cacheRead,
        cacheWrite: d.model.cost.cacheWrite,
      },
      thinkingLevel: d.model.thinkingLevel,
      thinkingLevelMap: d.model.thinkingLevelMap,
      compat: { ...DEFAULT_COMPAT, ...d.model.compat },
    },
    defaultTimeoutMinutes: d.worker.defaultTimeoutMinutes,
    pollIntervalSeconds: d.worker.pollIntervalSeconds,
    startupPollSeconds: d.worker.startupPollSeconds,
    startupWait: d.worker.startupWait,
    endpointProbe: d.worker.endpointProbe,
    maxTransientRetries: d.worker.maxTransientRetries,
    retryBackoffSeconds: d.worker.retryBackoffSeconds,
    maxConcurrent: d.worker.maxConcurrent,
    commitLeftoversEnabled: d.worker.commitLeftovers,
    applyFallbackToAgent: d.worker.applyFallbackToAgent,
    dailyBudgetUsd: d.worker.dailyBudgetUsd,
    supervisorEnabled: d.supervisor.enabled,
    supervisorBudgetPerKind: d.supervisor.budgetPerKind,
    supervisorEscalationWindow: d.supervisor.escalationWindowTurns,
    supervisorOutputBudgetPerTurn: d.supervisor.outputBudgetPerTurn,
    supervisorOutputBudgetPostCommit: d.supervisor.outputBudgetPostCommit,
    gitBin: d.git.gitBin,
    ghBin: d.git.ghBin,
    defaultBaseBranch: d.git.defaultBaseBranch,
    branchPrefix: d.git.branchPrefix,
    worktreeRoot: nWorktree
      ? expandHome(nWorktree)
      : join(dataDir, dataLayout === "v2" ? "cache/worktrees" : "worktrees"),
    removeWorktreeOnSuccess: d.git.removeWorktreeOnSuccess,
    allowedRepoRoots: d.git.allowedRepoRoots.map(expandHome),
    draftByDefault: d.pr.draftByDefault,
    defaultLabels: d.pr.defaultLabels,
    secretScanEnabled: d.pr.secretScan,
    verifyEnabled: d.verify.enabled,
    verifyCommandTimeout: d.verify.commandTimeout,
    verifyBlockOnFail: d.verify.blockOnFail,
    verifySandboxed: d.verify.sandboxed,
    criticEnabled: d.critic.enabled,
    criticMaxRetries: d.critic.maxRetries,
    criticThinking: d.critic.thinking,
    planLintEnabled: d.planLint.enabled,
    planLintBlockOnError: d.planLint.blockOnError,
    planLintCheckLabels: d.planLint.checkLabels,
    healthEnabled: d.observability.healthEnabled,
    healthHost: d.observability.healthHost,
    healthPort: d.observability.healthPort,
    logLevel: d.observability.logLevel,
    logToFile: d.observability.logToFile,
    transcriptsEnabled: d.observability.transcripts,
    github: {
      enabled: d.github.enabled,
      triggerLabel: d.github.triggerLabel,
      askLabel: d.github.askLabel ?? `${d.github.triggerLabel}:ask`,
      pollIntervalSeconds: d.github.pollIntervalSeconds,
      requireApproval: d.github.requireApproval,
      plannerModelId: d.github.plannerModelId ?? null,
      externalReposRoot: nExternal
        ? expandHome(nExternal)
        : join(dataDir, dataLayout === "v2" ? "cache/clones/external" : "clones/external"),
      repos: d.github.repos.map((r) => ({ nwo: r.nwo, path: expandHome(r.path) })),
    },
    assess: {
      maxIssuesPerRun: d.assess.maxIssuesPerRun,
      minSeverity: d.assess.minSeverity,
      npmBin: d.assess.npmBin,
      fileAs: d.assess.fileAs,
    },
    skills: {
      harnessDirs: d.skills.harnessDirs.map(expandHome),
    },
    sandbox: {
      enabled: d.sandbox.enabled,
      backend: d.sandbox.backend,
      requireBackend: d.sandbox.requireBackend,
      network: d.sandbox.network,
      extraDenyRead: d.sandbox.extraDenyRead.map(expandHome),
      extraAllowWrite: d.sandbox.extraAllowWrite.map(expandHome),
      bashTimeoutSeconds: d.sandbox.bashTimeoutSeconds,
    },
    botAccount: {
      enabled: d.botAccount.enabled,
      configDir: ghConfigDir,
    },
    planSets: {
      enabled: d.planSets.enabled,
      mergePollSeconds: d.planSets.mergePollSeconds,
      maxTasks: d.planSets.maxTasks,
    },
  };
}

export function loadConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): Config {
  return assembleConfig(parseConfigFile(path), env);
}

/** One human-readable deprecation per legacy path key set in config.json.
 * Surfaced by daemon startup, `junco doctor`, and `junco data` (spec §5).
 * The migrate hint is reserved for the keys `junco data migrate` actually
 * unifies (vaultRoot/juncoSubdir, observability.stateDir); worktreeRoot and
 * externalReposRoot are NOT moved by it, so their hints are key-specific
 * removal instructions — pointing those at the migrate would loop the
 * operator (the warning would survive every run). */
export function configDeprecations(cfg: Config): string[] {
  const out: string[] = [];
  const hint = "run 'junco data migrate' to unify (docs/configuration.md)";
  if (cfg.legacy.vaultRoot)
    out.push(
      `config: vaultRoot/juncoSubdir are deprecated — the queue lives at <dataDir>/queue; ${hint}`,
    );
  if (cfg.legacy.stateDir)
    out.push(`config: observability.stateDir is deprecated — use top-level dataDir; ${hint}`);
  if (cfg.legacy.worktreeRoot)
    out.push(
      "config: git.worktreeRoot is deprecated — remove the key (with the daemon idle); " +
        "worktrees are disposable and will be recreated under <dataDir>/worktrees " +
        "(docs/configuration.md)",
    );
  if (cfg.legacy.externalReposRoot)
    out.push(
      "config: github.externalReposRoot is deprecated — remove the key; external clones " +
        "re-clone under <dataDir>/clones/external on next use (or move them there first) " +
        "(docs/configuration.md)",
    );
  if (cfg.legacy.dataRoot)
    out.push(
      "config: data lives at the legacy ~/.local/state/junco root — " +
        "run 'junco data migrate' to move it under ~/.junco (docs/configuration.md)",
    );
  if (cfg.legacy.ghConfigDir)
    out.push(
      "config: bot gh credentials live at the legacy ~/.config/junco/gh — " +
        "run 'junco data migrate' to move them to ~/.junco/gh",
    );
  return out;
}
