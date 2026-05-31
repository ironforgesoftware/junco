#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { runOnce } from "./runOnce.js";
import { log } from "./logging.js";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", default: "config.toml" },
      "run-once": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const cfg = loadConfig(values.config as string);
  // M1 ships only the one-shot path; the daemon poll loop is a later milestone.
  const handled = await runOnce(cfg);
  log.info("run-once complete", { handled });
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  log.error("fatal", { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  process.exit(1);
});
