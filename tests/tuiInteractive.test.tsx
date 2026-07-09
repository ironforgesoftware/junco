import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { AddRepoForm } from "../src/tui/components/AddRepoForm.js";
import { until } from "./helpers/until.js";

// IssueDetail was deleted in the workspace switch; its body/plan/loading/no-plan
// coverage now lives in tests/tuiPreview.test.tsx (the Preview component).

describe("AddRepoForm", () => {
  it("captures nwo + path across enter presses and submits", async () => {
    let submitted: [string, string] | null = null;
    const { stdin, lastFrame } = render(
      <AddRepoForm
        error={null}
        busyText={null}
        onSubmit={(nwo, path) => {
          submitted = [nwo, path];
        }}
        onCancel={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("acme/api");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("\r"); // → path field
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("/c/api");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("\r"); // submit
    // The submit lands via ink's input pipeline — bounded until-loop, never a
    // fixed tick (a loaded CI runner races React's commit past any fixed delay).
    await until(() => submitted !== null);
    expect(submitted).toEqual(["acme/api", "/c/api"]);
    expect(lastFrame()).toContain("Watch a repository");
  });

  it("renders a validation error and busy state", () => {
    const e = render(
      <AddRepoForm
        error="clone origin is other/thing"
        busyText={null}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(e.lastFrame()).toContain("origin");
    const b = render(
      <AddRepoForm error={null} busyText={"validating…"} onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(b.lastFrame()).toContain("validating");
  });
});
