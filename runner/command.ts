#!/usr/bin/env -S npx -y tsx
/**
 * Print one configured command from factory.yaml, or nothing if it is unset or TODO.
 *
 * CI used to `grep` and `sed` the manifest itself, which meant a second, weaker parser
 * with different opinions about quoting: `test: "npm test"` came back with its quotes
 * attached and failed as a single unknown command. The gate the agent runs and the gate
 * CI runs have to be the same string, read the same way.
 *
 * Usage:  npx tsx runner/command.ts test
 * Exit 0 with empty output when the command is not configured — an absent gate is a
 * warning for the caller to surface, not a crash.
 */

import { loadConfig } from "./config.ts";
import { isMain } from "./cli.ts";

if (isMain(import.meta.url)) {
  const name = process.argv[2];
  if (!name) {
    console.error("usage: command.ts <setup|lint|typecheck|test|build|...>");
    process.exit(64);
  }
  try {
    const command = loadConfig().commands[name];
    if (command) process.stdout.write(command + "\n");
  } catch (err) {
    console.error(`command: ${(err as Error).message}`);
    process.exit(1);
  }
}
