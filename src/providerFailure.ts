/**
 * Classify a provider/session error string into an infrastructure failure
 * class. The SDK flattens HTTP status into display text (no structured codes
 * reach the event stream — verified against pi-coding-agent 0.80.3), so this
 * is deliberately text-pattern based, mirroring the SDK's own retry matcher.
 * Order matters: quota errors ride a 429, so quota is checked before
 * rate_limit; model_not_found often carries a 404 that must not read as
 * outage. Outage is split into two regexes: human phrases match
 * case-insensitively, while errno tokens (ECONNREFUSED, ...) stay
 * case-sensitive so prose can't accidentally hit them. "permission denied"
 * is deliberately NOT an auth signal — Node fs errors (EACCES on
 * .git/index.lock etc.) carry that phrase, and crash-path reason strings
 * reach this classifier.
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
  /\b40[13]\b|unauthorized|forbidden|invalid[_ -]?(?:api[_ -]?key|x-api-key|bearer token)|authentication[_ -]?(?:error|failed)/i;
const MODEL_NOT_FOUND =
  /model[_ ]not[_ ]found|model[^\n]{0,60}(?:not found|does not exist)|unknown model|did not resolve from the builtin catalog/i;
const RATE_LIMIT = /\b429\b|rate[_ -]?limit|overloaded|too many requests/i;
const OUTAGE_TEXT =
  /\b5\d{2}\b|bad gateway|service unavailable|internal server error|fetch failed|socket hang up/i;
const OUTAGE_ERRNO = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE/;

export function classifyProviderFailure(
  errorText: string | null | undefined,
): ProviderFailureClass {
  if (!errorText) return "unknown";
  if (QUOTA.test(errorText)) return "quota";
  if (AUTH.test(errorText)) return "auth";
  if (MODEL_NOT_FOUND.test(errorText)) return "model_not_found";
  if (RATE_LIMIT.test(errorText)) return "rate_limit";
  if (OUTAGE_TEXT.test(errorText) || OUTAGE_ERRNO.test(errorText)) return "outage";
  return "unknown";
}

// Failure classes that are the provider's fault, not the ticket's: an
// operator-fixable misconfiguration (auth/quota/model typo) or an active rate
// limit. These route through the gate and requeueTicketKeepBudget instead of
// the budgeted transient-retry path — see the Q&A/crash sites in runOnce.ts
// and the two zero-commit failure sites in prFlow.ts. Shared here (rather than
// declared per-module) so both callers route the exact same set.
export const GATE_CLASSES: ReadonlySet<ProviderFailureClass> = new Set([
  "auth",
  "quota",
  "rate_limit",
  "model_not_found",
]);
