export interface OmlxConfig { url: string; apiKey: string; }
export interface Config {
  vaultRoot: string;
  juncoSubdir: string;
  omlx: OmlxConfig;
  modelId: string;
  tools: string[];
  defaultTimeoutMinutes: number;
}
export interface Paths { inbox: string; processing: string; done: string; failed: string; }

export interface Ticket {
  path: string;
  id: string;
  priority: "low" | "normal" | "high";
  timeoutSeconds: number;
  body: string;
  frontmatter: Record<string, unknown>;
  hasRepo: boolean;
}

export interface ToolCall { name: string; args: unknown; }
export interface Usage { input: number; output: number; cacheRead: number; total: number; }
export interface RunResult {
  finalText: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: string | null;
  errorMessage: string | null;
  timedOut: boolean;
  durationMs: number;
}
