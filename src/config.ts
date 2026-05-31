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
    tools: DEFAULT_TOOLS,
    defaultTimeoutMinutes: d.worker.default_timeout_minutes,
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
