/**
 * Tests for src/service.ts — renderLaunchdPlist, renderSystemdUnit, renderService.
 *
 * TDD for M4-T6: cross-platform service-file rendering (launchd + systemd).
 */

import { describe, it, expect } from "vitest";
import { renderLaunchdPlist, renderSystemdUnit, renderService } from "../src/service.js";

// ---------------------------------------------------------------------------
// Shared opts for deterministic tests
// ---------------------------------------------------------------------------

const BASE_OPTS = {
  cliEntry: "/x/dist/cli.js",
  configPath: "/x/config.toml",
  nodeBin: "/usr/bin/node",
  label: "com.junco.test",
  logDir: "/x/logs",
  home: "/home/user",
  pathEnv: "/usr/bin:/bin",
};

// ---------------------------------------------------------------------------
// renderLaunchdPlist
// ---------------------------------------------------------------------------

describe("renderLaunchdPlist", () => {
  it("includes nodeBin in ProgramArguments", () => {
    const out = renderLaunchdPlist(BASE_OPTS);
    expect(out).toContain("<string>/usr/bin/node</string>");
  });

  it("includes cliEntry in ProgramArguments", () => {
    const out = renderLaunchdPlist(BASE_OPTS);
    expect(out).toContain("<string>/x/dist/cli.js</string>");
  });

  it("includes 'start' in ProgramArguments", () => {
    const out = renderLaunchdPlist(BASE_OPTS);
    expect(out).toContain("<string>start</string>");
  });

  it("includes '--config' in ProgramArguments", () => {
    const out = renderLaunchdPlist(BASE_OPTS);
    expect(out).toContain("<string>--config</string>");
  });

  it("includes configPath in ProgramArguments", () => {
    const out = renderLaunchdPlist(BASE_OPTS);
    expect(out).toContain("<string>/x/config.toml</string>");
  });

  it("includes the Label", () => {
    const out = renderLaunchdPlist(BASE_OPTS);
    expect(out).toContain("<key>Label</key>");
    expect(out).toContain("<string>com.junco.test</string>");
  });

  it("includes KeepAlive with SuccessfulExit false", () => {
    const out = renderLaunchdPlist(BASE_OPTS);
    expect(out).toContain("<key>KeepAlive</key>");
    expect(out).toContain("<key>SuccessfulExit</key><false/>");
  });

  it("includes ThrottleInterval 30", () => {
    const out = renderLaunchdPlist(BASE_OPTS);
    expect(out).toContain("<integer>30</integer>");
  });

  it("includes launchd.out under logDir", () => {
    const out = renderLaunchdPlist(BASE_OPTS);
    expect(out).toContain("/x/logs/launchd.out");
  });

  it("includes launchd.err under logDir", () => {
    const out = renderLaunchdPlist(BASE_OPTS);
    expect(out).toContain("/x/logs/launchd.err");
  });

  it("includes RunAtLoad true", () => {
    const out = renderLaunchdPlist(BASE_OPTS);
    expect(out).toContain("<key>RunAtLoad</key><true/>");
  });

  it("includes ProcessType Background", () => {
    const out = renderLaunchdPlist(BASE_OPTS);
    expect(out).toContain("<string>Background</string>");
  });

  it("includes Environment HOME", () => {
    const out = renderLaunchdPlist(BASE_OPTS);
    expect(out).toContain("<key>HOME</key>");
  });

  it("includes Environment PATH", () => {
    const out = renderLaunchdPlist(BASE_OPTS);
    expect(out).toContain("<key>PATH</key>");
  });

  it("uses default label 'com.junco.worker' when label omitted", () => {
    const { label: _l, ...noLabel } = BASE_OPTS;
    const out = renderLaunchdPlist(noLabel);
    expect(out).toContain("<string>com.junco.worker</string>");
  });

  it("uses process.execPath when nodeBin omitted", () => {
    const { nodeBin: _n, ...noNode } = BASE_OPTS;
    const out = renderLaunchdPlist(noNode);
    // process.execPath is the node binary — it should appear in output
    expect(out).toContain(`<string>${process.execPath}</string>`);
  });

  it("derives logDir from configPath dir when logDir omitted", () => {
    const { logDir: _l, ...noLogDir } = BASE_OPTS;
    const out = renderLaunchdPlist(noLogDir);
    // configPath is /x/config.toml → dir is /x → logs go to /x/launchd.out
    expect(out).toContain("/x/launchd.out");
    expect(out).toContain("/x/launchd.err");
  });

  describe("XML escaping", () => {
    it("escapes & in label to &amp;", () => {
      const out = renderLaunchdPlist({ ...BASE_OPTS, label: "foo&bar" });
      expect(out).toContain("foo&amp;bar");
      expect(out).not.toContain("foo&bar<");
    });

    it("escapes < in values", () => {
      const out = renderLaunchdPlist({ ...BASE_OPTS, label: "foo<bar" });
      expect(out).toContain("foo&lt;bar");
    });

    it("escapes > in values", () => {
      const out = renderLaunchdPlist({ ...BASE_OPTS, label: "foo>bar" });
      expect(out).toContain("foo&gt;bar");
    });
  });
});

// ---------------------------------------------------------------------------
// renderSystemdUnit
// ---------------------------------------------------------------------------

describe("renderSystemdUnit", () => {
  it("contains ExecStart with nodeBin cliEntry start --config configPath", () => {
    const out = renderSystemdUnit(BASE_OPTS);
    expect(out).toContain("ExecStart=/usr/bin/node /x/dist/cli.js start --config /x/config.toml");
  });

  it("contains Restart=on-failure", () => {
    const out = renderSystemdUnit(BASE_OPTS);
    expect(out).toContain("Restart=on-failure");
  });

  it("contains RestartSec=30", () => {
    const out = renderSystemdUnit(BASE_OPTS);
    expect(out).toContain("RestartSec=30");
  });

  it("contains WantedBy=default.target", () => {
    const out = renderSystemdUnit(BASE_OPTS);
    expect(out).toContain("WantedBy=default.target");
  });

  it("contains Environment=HOME=", () => {
    const out = renderSystemdUnit(BASE_OPTS);
    expect(out).toContain("Environment=HOME=");
  });

  it("contains Environment=PATH=", () => {
    const out = renderSystemdUnit(BASE_OPTS);
    expect(out).toContain("Environment=PATH=");
  });

  it("contains [Unit] section", () => {
    const out = renderSystemdUnit(BASE_OPTS);
    expect(out).toContain("[Unit]");
  });

  it("contains [Service] section", () => {
    const out = renderSystemdUnit(BASE_OPTS);
    expect(out).toContain("[Service]");
  });

  it("contains [Install] section", () => {
    const out = renderSystemdUnit(BASE_OPTS);
    expect(out).toContain("[Install]");
  });

  it("contains Type=simple", () => {
    const out = renderSystemdUnit(BASE_OPTS);
    expect(out).toContain("Type=simple");
  });

  it("contains Description=Junco task-queue worker", () => {
    const out = renderSystemdUnit(BASE_OPTS);
    expect(out).toContain("Description=Junco task-queue worker");
  });
});

// ---------------------------------------------------------------------------
// renderService dispatch
// ---------------------------------------------------------------------------

describe("renderService", () => {
  it("dispatches 'launchd' → plist output containing <plist", () => {
    const out = renderService("launchd", BASE_OPTS);
    expect(out).toContain("<plist");
  });

  it("dispatches 'systemd' → unit output containing [Unit]", () => {
    const out = renderService("systemd", BASE_OPTS);
    expect(out).toContain("[Unit]");
  });
});

// ---------------------------------------------------------------------------
// Stop timeouts — the supervisor must outwait a draining in-flight ticket
// ---------------------------------------------------------------------------

describe("stop timeouts", () => {
  it("launchd plist sets ExitTimeOut from stopTimeoutSeconds", () => {
    const out = renderLaunchdPlist({ ...BASE_OPTS, stopTimeoutSeconds: 2460 });
    expect(out).toContain("<key>ExitTimeOut</key><integer>2460</integer>");
  });

  it("systemd unit sets TimeoutStopSec from stopTimeoutSeconds", () => {
    const out = renderSystemdUnit({ ...BASE_OPTS, stopTimeoutSeconds: 2460 });
    expect(out).toContain("TimeoutStopSec=2460");
  });

  it("defaults stopTimeoutSeconds to 2400 (40 min — default 30-min ticket + drain margin)", () => {
    expect(renderLaunchdPlist(BASE_OPTS)).toContain(
      "<key>ExitTimeOut</key><integer>2400</integer>",
    );
    expect(renderSystemdUnit(BASE_OPTS)).toContain("TimeoutStopSec=2400");
  });
});
