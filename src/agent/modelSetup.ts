/**
 * Model + provider resolution — turns the resolved `cfg.model` config into the
 * inputs the Pi SDK's ModelRegistry needs, WITHOUT importing the SDK (so this
 * stays pure and unit-testable). `session.ts` consumes these; `health.ts` uses
 * `resolveProbeBaseUrl` for its reachability probe.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Config, ModelConfig } from "../types.js";

/**
 * Split a provider-prefixed model id ("openai/gpt-4o-mini") into its provider and
 * bare model id. Splits on the FIRST "/" only, so model ids that themselves
 * contain slashes (e.g. "openrouter/anthropic/claude") are preserved. If there
 * is no "/", the whole string is treated as the model id under the default
 * "local" provider.
 */
export function splitModelId(full: string): { provider: string; modelId: string } {
  const slash = full.indexOf("/");
  if (slash === -1) return { provider: "local", modelId: full };
  return { provider: full.slice(0, slash), modelId: full.slice(slash + 1) };
}

/** The fields the source rule needs — ModelConfig satisfies this structurally. */
export interface ModelSourceFields {
  source: "auto" | "catalog" | "inline";
  id: string;
  baseUrlExplicit: boolean;
}

/**
 * Should this model resolve from the SDK's builtin hosted catalog?  Explicit
 * `model.source` always wins; under "auto" a non-`local` provider prefix opts
 * in unless the user explicitly set `model.baseUrl` (an explicit endpoint
 * means a deliberate proxy/override → inline).
 */
export function catalogEligible(m: ModelSourceFields): boolean {
  if (m.source === "catalog") return true;
  if (m.source === "inline") return false;
  return splitModelId(m.id).provider !== "local" && !m.baseUrlExplicit;
}

/**
 * Whether the readiness machinery should probe the endpoint at all.  Hosted
 * catalog models have no local server to wait for, and probing a metered API
 * on every poll/dashboard tick is billed traffic.  A configured models.json
 * still probes (its provider baseUrl may be local).  Phase 2 replaces the
 * boolean call sites with the provider gate; this predicate survives.
 */
export function shouldProbeEndpoint(m: ModelConfig): boolean {
  return !(catalogEligible(m) && !m.modelsJson);
}

/**
 * Derive the OpenAI-compatible API base from a configured endpoint URL. A
 * config's base_url may point at the list-models endpoint (`.../v1/models`),
 * but the provider baseUrl must be the API root (`.../v1`). Strip a trailing
 * `/models` (with optional trailing slash); otherwise return as-is.
 */
export function apiBaseUrl(url: string): string {
  return url.replace(/\/models\/?$/, "");
}

export interface InlineProviderConfig {
  provider: string;
  modelId: string;
  /** Shape matches Pi's ProviderConfigInput; typed loosely so this file needs
   * no SDK import. session.ts casts it at the registerProvider call. */
  providerConfig: Record<string, unknown>;
}

/**
 * Build a Pi `ProviderConfigInput` (+ the provider/model ids) from the inline
 * `cfg.model.*` fields. Used by the in-memory registry path in session.ts.
 * Pure — no SDK, no I/O.
 */
export function buildInlineProviderConfig(cfg: Config): InlineProviderConfig {
  const m = cfg.model;
  const { provider, modelId } = splitModelId(m.id);
  return {
    provider,
    modelId,
    providerConfig: {
      name: provider,
      baseUrl: apiBaseUrl(m.baseUrl),
      // registerProvider RUNTIME-validates an apiKey is present when models are
      // defined (the type marks it optional); the session also sets a runtime key.
      apiKey: m.apiKey,
      api: m.api,
      models: [
        {
          id: modelId,
          name: modelId,
          reasoning: m.reasoning,
          input: m.input,
          cost: {
            input: m.cost.input,
            output: m.cost.output,
            cacheRead: m.cost.cacheRead,
            cacheWrite: m.cost.cacheWrite,
          },
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          // The SDK reads thinkingLevelMap from the MODEL spec (not compat) —
          // without it, effort names reach the chat template unmapped.
          thinkingLevelMap: m.thinkingLevelMap,
          // compat is per-MODEL in the programmatic API (the on-disk models.json
          // splits it provider/model). maxTokensField is load-bearing — some
          // servers (oMLX) reject the auto-detected `max_completion_tokens`.
          compat: m.compat,
        },
      ],
    },
  };
}

export interface RegistryLike {
  find(provider: string, modelId: string): unknown;
  registerProvider(name: string, config: Record<string, unknown>): void;
}
export interface RegistryOps {
  fromFile(modelsJsonPath: string): RegistryLike;
  inMemory(): RegistryLike;
}
export interface ResolvedModel {
  model: unknown;
  registry: RegistryLike;
  path: "models_json" | "catalog" | "inline";
}

/**
 * The three-way model resolution cascade — models.json → builtin catalog →
 * inline — behind a registry seam so tests never import the SDK.  Catalog
 * resolution deliberately never calls registerProvider: registering an inline
 * provider REPLACES the SDK's builtin models for that provider (the pre-Phase-1
 * bug that bound "anthropic/…" to the local default endpoint).
 */
export function resolveModelViaRegistries(
  cfg: Config,
  ops: RegistryOps,
  warn: (msg: string, meta?: Record<string, unknown>) => void = () => {},
): ResolvedModel {
  const m = cfg.model;
  const { provider, modelId } = splitModelId(m.id);

  if (m.modelsJson && existsSync(m.modelsJson)) {
    const registry = ops.fromFile(m.modelsJson);
    const model = registry.find(provider, modelId);
    if (model) return { model, registry, path: "models_json" };
    warn("model not in models.json; falling through", {
      modelsJson: m.modelsJson,
      provider,
      modelId,
    });
  }

  if (catalogEligible(m)) {
    const registry = ops.inMemory();
    const model = registry.find(provider, modelId);
    if (model) return { model, registry, path: "catalog" };
    warn("model not in the builtin catalog; falling through to inline", { provider, modelId });
  }

  if (m.apiKey === null) {
    throw new Error(
      `model "${m.id}": provider "${provider}" did not resolve from the builtin catalog and no ` +
        `inline endpoint is configured — set model.baseUrl + model.apiKey, point model.modelsJson ` +
        `at a Pi models.json, or use a catalog provider id.`,
    );
  }
  const registry = ops.inMemory();
  const { providerConfig } = buildInlineProviderConfig(cfg);
  registry.registerProvider(provider, providerConfig);
  const model = registry.find(provider, modelId);
  if (!model) {
    throw new Error(
      `Pi model "${provider}/${modelId}" not found in registry (baseUrl: ${apiBaseUrl(m.baseUrl)}).`,
    );
  }
  return { model, registry, path: "inline" };
}

/**
 * The endpoint the health probe should hit. When `models_json` is configured
 * and present, read the provider's `baseUrl` from that file (so the probe
 * targets the endpoint declared there); otherwise normalise `cfg.model.baseUrl`.
 * Pure JSON read — no SDK.
 */
export function resolveProbeBaseUrl(cfg: Config): string {
  const m = cfg.model;
  if (m.modelsJson && existsSync(m.modelsJson)) {
    try {
      const data = JSON.parse(readFileSync(m.modelsJson, "utf8")) as {
        providers?: Record<string, { baseUrl?: string }>;
      };
      const { provider } = splitModelId(m.id);
      const fileBase = data.providers?.[provider]?.baseUrl;
      if (fileBase) return apiBaseUrl(String(fileBase));
    } catch {
      // Unreadable/invalid models.json — fall back to the inline base_url.
    }
  }
  return apiBaseUrl(m.baseUrl);
}
