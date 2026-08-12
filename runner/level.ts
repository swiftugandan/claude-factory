#!/usr/bin/env -S npx -y tsx
/**
 * Print the configured autonomy level, so shell callers do not have to parse YAML.
 * Prints `off` and exits non-zero when the manifest is missing or unreadable —
 * a caller that ignores the exit code still gets the fail-closed answer.
 */

import { loadConfig } from "./config.ts";
import { isMain } from "./cli.ts";

if (isMain(import.meta.url)) {
  try {
    process.stdout.write(loadConfig().autonomy.level + "\n");
  } catch (err) {
    console.error(`level: ${(err as Error).message}`);
    process.stdout.write("off\n");
    process.exit(1);
  }
}
