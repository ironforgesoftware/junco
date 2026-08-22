import { sep } from "node:path";

export type RuleEffect = "allow" | "deny";

export interface ReadRule {
  /** Absolute, already-canonicalized path. */
  path: string;
  effect: RuleEffect;
  /** "subtree" = path and everything under it; "file" = this exact path. */
  kind: "subtree" | "file";
}

/** True when `abs` is `r` itself or lies inside the subtree rooted at `r`,
 *  matched on path boundaries (never a raw string prefix). Mirrors the
 *  `isUnder` shape in pathJail.ts:23-26 — rules here are already-canonical
 *  absolute paths, so no further resolution happens. */
function isUnder(abs: string, r: string): boolean {
  return abs === r || abs.startsWith(r + sep);
}

function matches(abs: string, rule: ReadRule): boolean {
  return rule.kind === "file" ? abs === rule.path : isUnder(abs, rule.path);
}

/** Segment depth of an absolute path, for specificity comparison. */
function depth(path: string): number {
  return path.split(sep).filter((segment) => segment.length > 0).length;
}

/**
 * Ascending specificity: least specific first. Backends that are
 * last-match-wins emit in exactly this order. Stable.
 *
 * Specificity order (most specific last): path segment depth ascending
 * (deeper wins); tie on depth -> "file" beats "subtree" (a literal is
 * narrower than a subtree at the same path); tie on both -> "deny" beats
 * "allow" (fail safe). Ties are otherwise stable in input order.
 */
export function orderRules(rules: ReadRule[]): ReadRule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => {
      const depthDiff = depth(a.rule.path) - depth(b.rule.path);
      if (depthDiff !== 0) return depthDiff;

      const kindRank = (kind: ReadRule["kind"]): number => (kind === "subtree" ? 0 : 1);
      const kindDiff = kindRank(a.rule.kind) - kindRank(b.rule.kind);
      if (kindDiff !== 0) return kindDiff;

      const effectRank = (effect: RuleEffect): number => (effect === "allow" ? 0 : 1);
      const effectDiff = effectRank(a.rule.effect) - effectRank(b.rule.effect);
      if (effectDiff !== 0) return effectDiff;

      return a.index - b.index;
    })
    .map(({ rule }) => rule);
}

/** Effect for an absolute path. No matching rule => "allow". */
export function resolveRead(abs: string, rules: ReadRule[]): RuleEffect {
  const ordered = orderRules(rules.filter((rule) => matches(abs, rule)));
  const winner = ordered[ordered.length - 1];
  return winner ? winner.effect : "allow";
}
