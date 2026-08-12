/** Shared CLI plumbing: argument reading and a reliable "was I run directly?" check. */

import { pathToFileURL } from "node:url";

export function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * True when this module is the entry point.
 * Compared through `pathToFileURL` rather than string concatenation so paths
 * containing spaces or non-ASCII characters still match.
 */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return importMetaUrl === pathToFileURL(entry).href;
}
