/**
 * Test-only render counter for the App-decomposition perf pass (spec
 * 2026-07-21-tui-app-decomposition). A no-op unless JUNCO_RENDER_COUNT=1, so
 * production and ordinary tests pay only one env read per render. Big leaf
 * components call bumpRender(name) in their body; the React.memo pass is
 * measured by driving an unrelated poll and comparing counts before/after.
 */
const counts: Record<string, number> = {};

export function bumpRender(name: string): void {
  if (process.env.JUNCO_RENDER_COUNT !== "1") return;
  counts[name] = (counts[name] ?? 0) + 1;
}

export function renderCounts(): Record<string, number> {
  return { ...counts };
}

export function resetRenderCounts(): void {
  for (const k of Object.keys(counts)) delete counts[k];
}
