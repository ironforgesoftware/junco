// tests/useBotLogin.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useBotLogin } from "../src/tui/hooks/useBotLogin.js";
import { until } from "./helpers/until.js";

function Probe({ fn }: { fn?: () => Promise<string | null> }) {
  const botLogin = useBotLogin(fn);
  return <Text>{botLogin ?? "none"}</Text>;
}

describe("useBotLogin", () => {
  it("resolves once on mount and reflects the bot login in state", async () => {
    const fn = async (): Promise<string | null> => "junco-bot";
    const r = render(<Probe fn={fn} />);
    expect(r.lastFrame()).toBe("none");
    await until(() => r.lastFrame() === "junco-bot");
    r.unmount();
  });

  it("stays null when botLoginFn is absent", async () => {
    const r = render(<Probe />);
    // Give any (incorrectly) scheduled async work a chance to resolve before
    // asserting the negative — there is nothing to poll toward here.
    await new Promise((res) => setTimeout(res, 20));
    expect(r.lastFrame()).toBe("none");
    r.unmount();
  });
});
