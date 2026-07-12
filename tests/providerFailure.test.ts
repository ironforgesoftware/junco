import { describe, it, expect } from "vitest";
import { classifyProviderFailure } from "../src/providerFailure.js";

describe("classifyProviderFailure", () => {
  it("null/undefined/empty → unknown", () => {
    expect(classifyProviderFailure(null)).toBe("unknown");
    expect(classifyProviderFailure(undefined)).toBe("unknown");
    expect(classifyProviderFailure("")).toBe("unknown");
  });

  it("auth: 401/403/unauthorized/invalid api key/authentication error", () => {
    for (const s of [
      '401 {"type":"error"} invalid x-api-key',
      "HTTP 403 Forbidden",
      "Unauthorized",
      "invalid_api_key: Incorrect API key provided",
      "authentication_error: invalid bearer token",
    ]) {
      expect(classifyProviderFailure(s), s).toBe("auth");
    }
  });

  it("quota beats rate_limit — insufficient_quota rides a 429", () => {
    expect(classifyProviderFailure("429 insufficient_quota: You exceeded your current quota")).toBe(
      "quota",
    );
    expect(classifyProviderFailure("billing hard limit reached")).toBe("quota");
  });

  it("model_not_found variants → model_not_found", () => {
    for (const s of [
      "404 model_not_found: The model `gpt-x` does not exist",
      'model "claude-nope" not found',
      "unknown model: qwen-9000",
    ]) {
      expect(classifyProviderFailure(s), s).toBe("model_not_found");
    }
  });

  it("catalog-miss / registry-miss session-build errors → model_not_found (runOnce crash containment)", () => {
    for (const s of [
      'model "anthropic/nope": provider "anthropic" did not resolve from the builtin catalog and no ' +
        "inline endpoint is configured — set model.baseUrl + model.apiKey, point model.modelsJson at " +
        "a Pi models.json, or use a catalog provider id.",
      'Pi model "openai/gpt-4o" not found in registry (baseUrl: https://api.openai.com/v1).',
    ]) {
      expect(classifyProviderFailure(s), s).toBe("model_not_found");
    }
  });

  it("rate_limit: 429 / rate limit / overloaded / too many requests", () => {
    for (const s of [
      "429 Too Many Requests",
      "rate_limit_error: rate limited",
      "overloaded_error: Overloaded",
    ]) {
      expect(classifyProviderFailure(s), s).toBe("rate_limit");
    }
  });

  it("outage: 5xx / network errnos / fetch failed", () => {
    for (const s of [
      "502 Bad Gateway",
      "503 Service Unavailable",
      "internal server error",
      "connect ECONNREFUSED 127.0.0.1:1234",
      "read ECONNRESET",
      "getaddrinfo ENOTFOUND api.example.com",
      "fetch failed",
      "socket hang up",
      "ETIMEDOUT",
    ]) {
      expect(classifyProviderFailure(s), s).toBe("outage");
    }
  });

  it("outage phrases match case-insensitively without an adjoining status digit", () => {
    for (const s of ["Bad Gateway", "Internal Server Error", "Service Unavailable"]) {
      expect(classifyProviderFailure(s), s).toBe("outage");
    }
  });

  it("errno tokens stay case-sensitive — lowercase 'econnrefused' is not an outage", () => {
    expect(classifyProviderFailure("econnrefused")).toBe("unknown");
  });

  it("fs EACCES / permission denied is not provider auth → unknown", () => {
    for (const s of [
      "Error: EACCES: permission denied, open '/repo/.git/index.lock'",
      "EACCES: permission denied, mkdir '/repo/worktrees/wt-1'",
    ]) {
      expect(classifyProviderFailure(s), s).toBe("unknown");
    }
  });

  it("ordinary agent text and guard kills → unknown", () => {
    expect(classifyProviderFailure("agent looped writing the same file")).toBe("unknown");
    expect(classifyProviderFailure("run aborted: output budget exceeded")).toBe("unknown");
  });
});
