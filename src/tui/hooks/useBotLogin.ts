import { useState, useEffect } from "react";

// Bot-account identity probe: fires once on mount (absent fn → the feature
// stays inert, botLogin stays null). `on` guards a late resolution against a
// post-unmount setState.
export function useBotLogin(fn?: () => Promise<string | null>): string | null {
  const [botLogin, setBotLogin] = useState<string | null>(null);
  useEffect(() => {
    if (!fn) return;
    let on = true;
    void fn().then((l) => {
      if (on) setBotLogin(l);
    });
    return () => {
      on = false;
    };
  }, [fn]);
  return botLogin;
}
