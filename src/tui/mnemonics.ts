/**
 * Pure mnemonic derivation for the dashboard's shortcut overhaul: each named
 * option's hotkey derives from its LABEL (first letter → later word-initials
 * → remaining letters, guarded verbs uppercase), claimed strictly in list
 * order per context. The winning character's index feeds the colored-char
 * rendering; render and dispatch both consume this one output.
 * Spec: docs/superpowers/specs/2026-07-20-tui-mnemonic-shortcuts-design.md §1.
 */

export interface MnemonicOption {
  id: string;
  label: string;
  /** Destructive: claims UPPERCASE candidates (shift = fat-finger guard). */
  guarded?: boolean;
  /** Claims a key but renders only in help (shift variants). */
  hidden?: boolean;
}

export interface DerivedMnemonic {
  id: string;
  key: string;
  label: string;
  /** Index in label of the winning char; null → key not shown in-label. */
  charIndex: number | null;
  guarded: boolean;
  hidden: boolean;
}

const AZ = "abcdefghijklmnopqrstuvwxyz";

/** Candidate letters for a label: first letter, then later word-initials,
 * then remaining letters left-to-right — deduped, letters only, lowercase. */
function candidates(label: string): string[] {
  const words = label
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  const seq: string[] = [];
  const push = (ch: string): void => {
    if (/[a-z]/.test(ch) && !seq.includes(ch)) seq.push(ch);
  };
  if (words.length > 0) push(words[0][0]);
  for (const w of words.slice(1)) push(w[0]);
  for (const w of words) for (const ch of w) push(ch);
  return seq;
}

export function deriveMnemonics(
  options: MnemonicOption[],
  ctx: { reserved?: ReadonlyMap<string, string>; excluded?: ReadonlySet<string> } = {},
): DerivedMnemonic[] {
  const reserved = ctx.reserved ?? new Map<string, string>();
  const excluded = ctx.excluded ?? new Set<string>();
  const claimed = new Set<string>(reserved.values());
  const out: DerivedMnemonic[] = [];
  for (const opt of options) {
    const guarded = opt.guarded === true;
    const hidden = opt.hidden === true;
    const reservedKey = reserved.get(opt.id);
    if (reservedKey !== undefined) {
      const idx = opt.label.toLowerCase().indexOf(reservedKey.toLowerCase());
      out.push({
        id: opt.id,
        key: reservedKey,
        label: opt.label,
        charIndex: idx >= 0 ? idx : null,
        guarded,
        hidden,
      });
      continue;
    }
    const seq = candidates(opt.label).map((c) => (guarded ? c.toUpperCase() : c));
    let key = seq.find((c) => !claimed.has(c) && !excluded.has(c));
    let charIndex: number | null = null;
    if (key !== undefined) {
      charIndex = opt.label.toLowerCase().indexOf(key.toLowerCase());
      if (charIndex < 0) charIndex = null;
    } else {
      // Exhaustion: first unclaimed a–z (uppercased for guarded). Real context
      // tables never reach this (viewActions.test asserts it); kept total so
      // the engine never throws.
      for (const ch of AZ) {
        const cand = guarded ? ch.toUpperCase() : ch;
        if (!claimed.has(cand) && !excluded.has(cand)) {
          key = cand;
          break;
        }
      }
      key = key ?? "?";
    }
    claimed.add(key);
    out.push({ id: opt.id, key, label: opt.label, charIndex, guarded, hidden });
  }
  return out;
}
