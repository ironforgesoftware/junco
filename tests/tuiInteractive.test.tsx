import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { IssueDetail } from "../src/tui/components/IssueDetail.js";
import { AddRepoForm } from "../src/tui/components/AddRepoForm.js";

const issue = {
  number: 42,
  title: "Add rate limiting",
  labels: ["junco", "junco:plan-ready"],
  updatedAt: "2026-07-06T10:00:00Z",
  url: "https://github.com/acme/api/issues/42",
};

describe("IssueDetail", () => {
  it("shows body and the plan comment when present", () => {
    const { lastFrame } = render(
      <IssueDetail
        issue={issue}
        trigger="junco"
        body={"Uploads hammer the API."}
        planComment={"<!-- junco:plan -->\nProposed plan…"}
        loading={false}
        scroll={0}
      />,
    );
    const f = lastFrame()!;
    expect(f).toContain("#42 Add rate limiting");
    expect(f).toContain("Uploads hammer the API.");
    expect(f).toContain("Proposed plan…");
  });

  it("shows loading and no-plan states", () => {
    const l = render(
      <IssueDetail
        issue={issue}
        trigger="junco"
        body={null}
        planComment={null}
        loading={true}
        scroll={0}
      />,
    );
    expect(l.lastFrame()).toContain("loading");
    const n = render(
      <IssueDetail
        issue={issue}
        trigger="junco"
        body={"b"}
        planComment={null}
        loading={false}
        scroll={0}
      />,
    );
    expect(n.lastFrame()).toContain("no plan posted yet");
  });
});

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
    await new Promise((r) => setTimeout(r, 20));
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
