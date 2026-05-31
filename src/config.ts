import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { Config, Paths } from "./types.js";

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return p;
}

// The tool allowlist is configured (parity with the Python worker) as a
// `--tools <csv>` pair inside `[pi].extra_args`, e.g.
//   extra_args = ["--tools", "bash,read,write,edit,grep,find,todo_write"]
// Extract that CSV; fall back to DEFAULT_TOOLS when no --tools is present.
function toolsFromExtraArgs(extraArgs: string[] | undefined): string[] {
  if (extraArgs) {
    const i = extraArgs.indexOf("--tools");
    if (i >= 0 && i + 1 < extraArgs.length) {
      const tools = extraArgs[i + 1].split(",").map((t) => t.trim()).filter(Boolean);
      if (tools.length > 0) return tools;
    }
  }
  return DEFAULT_TOOLS;
}

const TomlSchema = z.object({
  vault_root: z.string({ required_error: "config: vault_root is required" }),
  junco_subdir: z.string().default("Junco"),
  pi: z.object({
    model_id: z.string().default("omlx/Qwen3.6-27B-oQ8-mtp"),
    extra_args: z.array(z.string()).optional(),
  }).default({}),
  oMLX: z.object({
    url: z.string().default("http://127.0.0.1:1234/v1"),
    api_key: z.string().default("1234"),
  }).default({}),
  worker: z.object({ default_timeout_minutes: z.number().default(30) }).default({}),
  // Loop-guard supervisor knobs. Python defaults: enabled false; here we
  // default enabled TRUE for the in-process agent run (M2). The numeric
  // defaults match the Python worker (budget_per_kind 1, escalation_window 3,
  // output_budget_per_turn 12000, output_budget_post_commit 24000).
  supervisor: z.object({
    enabled: z.boolean().default(true),
    budget_per_kind: z.number().default(1),
    escalation_window_turns: z.number().default(3),
    output_budget_per_turn: z.number().default(12000),
    output_budget_post_commit: z.number().default(24000),
  }).default({}),
  git: z.object({
    git_bin: z.string().default("git"),
    gh_bin: z.string().default("gh"),
    default_base_branch: z.string().default("main"),
    branch_prefix: z.string().default("junco/"),
    worktree_root: z.string().default("~/junco/worktrees"),
    remove_worktree_on_success: z.boolean().default(true),
  }).default({}),
  pr: z.object({
    draft_by_default: z.boolean().default(true),
    default_labels: z.array(z.string()).default([]),
  }).default({}),
  verify: z.object({
    enabled: z.boolean().default(true),
    command_timeout: z.number().default(60),
    block_on_fail: z.boolean().default(false),
  }).default({}),
  critic: z.object({
    enabled: z.boolean().default(true),
    max_retries: z.number().default(1),
    thinking: z.string().default("minimal"),
  }).default({}),
});

export function loadConfig(path: string): Config {
  const raw = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  // Accept both [oMLX] and [omlx] section casings (parity with the Python
  // load_config, which read data.get("oMLX", data.get("omlx", {}))).
  if (raw.oMLX === undefined && raw.omlx !== undefined) raw.oMLX = raw.omlx;
  const d = TomlSchema.parse(raw);
  return {
    vaultRoot: expandHome(d.vault_root),
    juncoSubdir: d.junco_subdir,
    omlx: { url: d.oMLX.url, apiKey: d.oMLX.api_key },
    modelId: d.pi.model_id,
    tools: toolsFromExtraArgs(d.pi.extra_args),
    defaultTimeoutMinutes: d.worker.default_timeout_minutes,
    supervisorEnabled: d.supervisor.enabled,
    supervisorBudgetPerKind: d.supervisor.budget_per_kind,
    supervisorEscalationWindow: d.supervisor.escalation_window_turns,
    supervisorOutputBudgetPerTurn: d.supervisor.output_budget_per_turn,
    supervisorOutputBudgetPostCommit: d.supervisor.output_budget_post_commit,
    gitBin: d.git.git_bin,
    ghBin: d.git.gh_bin,
    defaultBaseBranch: d.git.default_base_branch,
    branchPrefix: d.git.branch_prefix,
    worktreeRoot: expandHome(d.git.worktree_root),
    removeWorktreeOnSuccess: d.git.remove_worktree_on_success,
    draftByDefault: d.pr.draft_by_default,
    defaultLabels: d.pr.default_labels,
    verifyEnabled: d.verify.enabled,
    verifyCommandTimeout: d.verify.command_timeout,
    verifyBlockOnFail: d.verify.block_on_fail,
    criticEnabled: d.critic.enabled,
    criticMaxRetries: d.critic.max_retries,
    criticThinking: d.critic.thinking,
  };
}

export function queuePaths(cfg: Config): Paths {
  const root = join(cfg.vaultRoot, cfg.juncoSubdir);
  return {
    inbox: join(root, "inbox"),
    processing: join(root, "processing"),
    done: join(root, "done"),
    failed: join(root, "failed"),
  };
}
