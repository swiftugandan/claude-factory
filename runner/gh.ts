/** Thin, shared wrapper around the `gh` CLI. No runtime dependencies beyond node and gh. */

import { execFileSync } from "node:child_process";

export function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

export function ghJson<T>(args: string[]): T {
  return JSON.parse(gh(args)) as T;
}

/** `owner/repo` for the current checkout. */
export function repoSlug(): string {
  return ghJson<{ nameWithOwner: string }>(["repo", "view", "--json", "nameWithOwner"])
    .nameWithOwner;
}

export function relabel(issue: number | string, remove: string, add: string): void {
  gh(["issue", "edit", String(issue), "--remove-label", remove, "--add-label", add]);
}

/** Commenting is never allowed to fail a reconciliation or a run. */
export function tryComment(issue: number | string, body: string): void {
  try {
    gh(["issue", "comment", String(issue), "--body", body]);
  } catch (err) {
    console.error(`gh: could not comment on #${issue}: ${(err as Error).message}`);
  }
}
