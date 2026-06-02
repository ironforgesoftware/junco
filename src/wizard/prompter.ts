/**
 * Prompt seam for the setup wizard. Production impl wraps @clack/prompts (colored,
 * boxed, arrow-key select, spinner); tests inject a scripted Prompter. Centralizes
 * cancel handling: any Ctrl-C/Ctrl-D throws WizardCancelled (caught by runInitWizard).
 */
import * as clack from "@clack/prompts";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

export interface Prompter {
  intro(title: string): void;
  note(msg: string, title?: string): void;
  text(opts: { message: string; default?: string; placeholder?: string }): Promise<string>;
  select(opts: { message: string; options: SelectOption[]; initial?: string }): Promise<string>;
  spinner<T>(start: string, task: () => Promise<T>, stop: (r: T) => string): Promise<T>;
}

/** Thrown when the user cancels (Ctrl-C/Ctrl-D) any prompt. */
export class WizardCancelled extends Error {
  constructor() {
    super("Setup cancelled");
    this.name = "WizardCancelled";
  }
}

export function clackPrompter(): Prompter {
  return {
    intro: (t) => clack.intro(t),
    note: (m, title) => clack.note(m, title),
    async text(opts) {
      const r = await clack.text({
        message: opts.message,
        placeholder: opts.placeholder ?? opts.default,
        defaultValue: opts.default,
      });
      if (clack.isCancel(r)) {
        clack.cancel("Setup cancelled.");
        throw new WizardCancelled();
      }
      return (r as string) || (opts.default ?? "");
    },
    async select(opts) {
      const r = await clack.select({
        message: opts.message,
        options: opts.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })),
        initialValue: opts.initial,
      });
      if (clack.isCancel(r)) {
        clack.cancel("Setup cancelled.");
        throw new WizardCancelled();
      }
      return r as string;
    },
    async spinner(start, task, stop) {
      const s = clack.spinner();
      s.start(start);
      try {
        const res = await task();
        s.stop(stop(res));
        return res;
      } catch (e) {
        s.stop("failed");
        throw e;
      }
    },
  };
}
