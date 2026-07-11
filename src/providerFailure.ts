/**
 * Classify a provider/session error string into an infrastructure failure
 * class. The SDK flattens HTTP status into display text (no structured codes
 * reach the event stream — verified against pi-coding-agent 0.80.3), so this
 * is deliberately text-pattern based, mirroring the SDK's own retry matcher.
 * Order matters: quota errors ride a 429, so quota is checked before
 * rate_limit; model_not_found often carries a 404 that must not read as
 * outage.
 */
export type ProviderFailureClass =
  | "auth"
  | "quota"
  | "model_not_found"
  | "rate_limit"
  | "outage"
  | "unknown";

const QUOTA = /insufficient[_ ]quota|exceeded your current quota|billing/i;
const AUTH =
  /\b40[13]\b|unauthorized|forbidden|invalid[_ -]?(?:api[_ -]?key|x-api-key|bearer token)|authentication[_ -]?(?:error|failed)|permission denied/i;
const MODEL_NOT_FOUND =
  /model[_ ]not[_ ]found|model[^\n]{0,60}(?:not found|does not exist)|unknown model/i;
const RATE_LIMIT = /\b429\b|rate[_ -]?limit|overloaded|too many requests/i;
const OUTAGE =
  /\b5\d{2}\b|bad gateway|service unavailable|internal server error|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|socket hang up/;

export function classifyProviderFailure(
  errorText: string | null | undefined,
): ProviderFailureClass {
  if (!errorText) return "unknown";
  if (QUOTA.test(errorText)) return "quota";
  if (AUTH.test(errorText)) return "auth";
  if (MODEL_NOT_FOUND.test(errorText)) return "model_not_found";
  if (RATE_LIMIT.test(errorText)) return "rate_limit";
  if (OUTAGE.test(errorText)) return "outage";
  return "unknown";
}
