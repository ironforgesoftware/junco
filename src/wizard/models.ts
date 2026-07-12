/**
 * Model discovery for the setup wizard: infer a provider label from an endpoint,
 * list a server's models (OpenAI-compatible /models), and list a Pi models.json's
 * entries. All best-effort and non-throwing so the wizard can fall back to manual.
 */
import { existsSync, readFileSync } from "node:fs";
import { apiBaseUrl } from "../agent/modelSetup.js";

/** Best-effort provider label from an endpoint URL (just an internal registry label). */
export function inferProvider(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "custom";
  }
  const known: Record<string, string> = {
    "api.openai.com": "openai",
    "openrouter.ai": "openrouter",
    "api.anthropic.com": "anthropic",
    "generativelanguage.googleapis.com": "google",
    "api.groq.com": "groq",
    "api.mistral.ai": "mistral",
    "api.deepseek.com": "deepseek",
  };
  if (known[host]) return known[host];
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host.endsWith(".local"))
    return "local";
  const labels = host
    .replace(/^api\./, "")
    .split(".")
    .filter(Boolean);
  if (labels.length >= 2) return labels[labels.length - 2];
  if (labels.length === 1) return labels[0];
  return "custom";
}

export interface FetchModelsDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** GET <base>/models (Bearer auth) → OpenAI-style data[].id. [] on any error/empty.
 * `apiKey: null` (deferred to the provider's env var — see resolveApiKey in
 * config.ts) omits the Authorization header entirely rather than sending
 * "Bearer null". */
export async function fetchModels(
  baseUrl: string,
  apiKey: string | null,
  deps: FetchModelsDeps = {},
): Promise<string[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const url = `${apiBaseUrl(baseUrl).replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, {
      method: "GET",
      headers: apiKey !== null ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const body = (await resp.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(body?.data)) return [];
    return body.data
      .map((m) => (typeof m?.id === "string" ? m.id : null))
      .filter((x): x is string => !!x);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** List "<provider>/<modelId>" for every model in a Pi models.json. [] if unreadable. */
export function parseModelsJson(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, "utf8")) as {
      providers?: Record<string, { models?: Array<{ id?: unknown }> }>;
    };
    const out: string[] = [];
    for (const [provider, p] of Object.entries(data.providers ?? {}))
      for (const m of p.models ?? [])
        if (typeof m?.id === "string") out.push(`${provider}/${m.id}`);
    return out;
  } catch {
    return [];
  }
}
