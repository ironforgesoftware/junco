/** Chapter — skill distribution: which detected harnesses get the
 * junco-dispatch skill linked (skills.harnessDirs consent list). Options are
 * the registry harnesses whose home dir exists on this machine; none detected
 * renders a note and continues. */
import React from "react";
import { Box, Text } from "ink";
import { Tip, MultiSelect, type ChapterProps } from "../controls.js";
import { TIPS } from "../../../wizard/tips.js";
import { useGuardedInput } from "../../useGuardedInput.js";
import { sameHarnessDir } from "../../../skillLinks.js";

/** First-occurrence-wins dedupe on sameHarnessDir — a config can already
 * hold both spellings of one harness dir (a pre-#292 double-write, or a
 * hand-edit), and the undetected-union filter below only strips entries
 * that match a DETECTED harness, so a same-dir duplicate among undetected
 * entries would otherwise be written straight back out. */
function dedupeHarnessDirs(dirs: string[]): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    if (!out.some((o) => sameHarnessDir(o, d))) out.push(d);
  }
  return out;
}

export function Skills({
  answers,
  patch,
  onNext,
  detectedHarnesses,
}: ChapterProps & { detectedHarnesses: { name: string; dir: string }[] }): React.JSX.Element {
  // useGuardedInput (not raw ink useInput — see its doc comment on leaked
  // mouse CSI) must be called unconditionally (rules-of-hooks) even though it
  // only matters on the no-harness branch below — isActive gates it there.
  useGuardedInput(
    (_input, key) => {
      if (key.return) onNext();
    },
    { isActive: detectedHarnesses.length === 0 },
  );

  if (detectedHarnesses.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No known agent harnesses detected — skipping skill links.</Text>
        <Text dimColor>Link one later with: junco skill install --harness {"<name|path>"}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        Link the junco-dispatch skill into these harnesses? (space toggles, enter continues)
      </Text>
      <Box marginTop={1}>
        <MultiSelect
          focus
          items={detectedHarnesses.map((h) => ({
            value: h.dir,
            label: `${h.name}  (${h.dir})`,
            // Pre-check: already-consented dirs on rerun; everything detected
            // on a fresh run (the operator still confirms with enter).
            // sameHarnessDir, not raw equality: the registry emits the tilde
            // spelling while loadConfig expands skills.harnessDirs, so a
            // config holding the absolute form of a detected tilde dir must
            // still pre-check (#292).
            checked:
              answers.harnessDirs.length > 0
                ? answers.harnessDirs.some((d) => sameHarnessDir(d, h.dir))
                : true,
          }))}
          onFocusChange={() => {}}
          onSubmit={(vals) => {
            // Union with configured-but-undetected dirs: the option list is
            // only the DETECTED set, so a bare replace would silently drop
            // consent for a harness that isn't installed on THIS machine —
            // configs roam between machines (skillLinks.ts), and an
            // uninstalled harness is a silent skip there, never a removal.
            // Revoking a DETECTED dir still works (uncheck it); an
            // undetected dir can only be removed by hand-editing config.
            // sameHarnessDir keeps this in step with the checked pre-check
            // above (#292).
            const undetected = answers.harnessDirs.filter(
              (d) => !detectedHarnesses.some((h) => sameHarnessDir(h.dir, d)),
            );
            // Dedupe: sameHarnessDir in the filter above stops a NEW
            // duplicate from arriving via the union, but a config that
            // already holds both spellings of one dir must still collapse
            // to one on write, not be carried through doubled.
            patch({ harnessDirs: dedupeHarnessDirs([...vals, ...undetected]) });
            onNext();
          }}
        />
      </Box>
      <Tip>{TIPS.skills}</Tip>
    </Box>
  );
}
