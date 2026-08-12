#!/usr/bin/env -S npx -y tsx
/**
 * Path enforcement for a factory run.
 *
 * This was previously inline shell in `run-task.sh` that approximated globs with a
 * `case` statement plus a prefix fallback, and never read `forbidden_paths` at all.
 * Enforcement that decides whether a branch may be pushed deserves to be a tested
 * function, so it lives here and the shell calls it.
 *
 * CLI:
 *   git diff --name-only base...HEAD | npx tsx runner/paths.ts --task-file <task.json>
 *
 * Exit codes:
 *   0  every changed file is inside allowed_paths and outside forbidden/guarded paths
 *   1  at least one violation (details on stderr, machine-readable JSON on stdout)
 */

import { readFileSync } from "node:fs";
import { argValue, hasFlag, isMain } from "./cli.ts";

/**
 * Paths a factory branch may never contain a change to.
 * The agent may propose harness changes through a separately reviewed, human-authored
 * PR; it may not ship them on a branch that the harness itself produced.
 *
 * `.github/workflows/factory-ci.yml` enforces the same list. `runner/paths.test.ts`
 * asserts the two stay identical, because a guardrail that drifts between layers is
 * worse than one layer — it reads as defended when it is not.
 */
export const GUARDED_PREFIXES: readonly string[] = [
  ".github/workflows/",
  ".claude/hooks/",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/factory/factory.yaml",
  "runner/",
  "CODEOWNERS",
  ".github/CODEOWNERS",
];

/**
 * Paths the PreToolUse hook blocks outright during any session, interactive or not.
 *
 * This is deliberately GUARDED_PREFIXES minus `factory.yaml`: interactively, a human
 * may need to fill in a real test command, so the hook applies the narrower rule of
 * blocking only edits that lower a quality gate. On an autonomous branch the broader
 * rule applies, because there is no human in the loop to judge the edit.
 */
export const HOOK_GUARDED_PREFIXES: readonly string[] = GUARDED_PREFIXES.filter(
  (p) => p !== ".claude/factory/factory.yaml"
);

export interface Violation {
  file: string;
  reason: string;
}

export function normalizePath(file: string): string {
  return file
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .trim();
}

/** Translate a git-style glob into an anchored regular expression. */
export function globToRegExp(pattern: string): RegExp {
  const p = normalizePath(pattern);
  let out = "";

  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**/` should also match zero directories, so `**/a.ts` matches `a.ts`.
        if (p[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(file: string, patterns: readonly string[]): boolean {
  const normalized = normalizePath(file);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

export function isGuarded(file: string, prefixes: readonly string[] = GUARDED_PREFIXES): boolean {
  const normalized = normalizePath(file);
  return prefixes.some((prefix) =>
    prefix.endsWith("/") ? normalized.startsWith(prefix) : normalized === prefix
  );
}

/**
 * Decide whether every changed file is in scope.
 *
 * Order matters and is deliberate: a guarded path is rejected even if the task's
 * allowed_paths would permit it, and forbidden_paths is evaluated after allowed_paths
 * so a narrow deny can carve a hole out of a broad allow.
 */
export function classifyChanges(
  files: readonly string[],
  allowed: readonly string[],
  forbidden: readonly string[] = [],
  guarded: readonly string[] = GUARDED_PREFIXES
): { ok: boolean; violations: Violation[] } {
  const violations: Violation[] = [];

  for (const raw of files) {
    const file = normalizePath(raw);
    if (!file) continue;

    if (isGuarded(file, guarded)) {
      violations.push({ file, reason: "part of the factory harness — requires a human-authored PR" });
      continue;
    }
    if (!matchesAny(file, allowed)) {
      violations.push({ file, reason: "outside the task's allowed_paths" });
      continue;
    }
    if (forbidden.length && matchesAny(file, forbidden)) {
      violations.push({ file, reason: "matches the task's forbidden_paths" });
    }
  }
  return { ok: violations.length === 0, violations };
}

function main(): void {
  const taskFile = argValue("task-file");
  const guardedOnly = hasFlag("guarded-only");

  if (!taskFile && !guardedOnly) {
    console.error("usage: paths.ts (--task-file <task.json> | --guarded-only) < changed-files");
    process.exit(64);
  }

  const files = readFileSync(0, "utf8").split("\n").map(normalizePath).filter(Boolean);

  // `--guarded-only` is what CI runs: it has no task contract in hand, only the rule
  // that a factory branch may not rewrite the harness. Sharing this implementation with
  // the runner is the point — a second copy in a workflow's grep is how the two drift.
  const result = guardedOnly
    ? classifyChanges(files, ["**"], [])
    : (() => {
        const task = JSON.parse(readFileSync(taskFile!, "utf8")) as {
          allowed_paths?: string[];
          forbidden_paths?: string[];
        };
        return classifyChanges(files, task.allowed_paths ?? [], task.forbidden_paths ?? []);
      })();

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  if (!result.ok) {
    console.error("paths: BLOCKED — changed files outside the permitted scope:");
    for (const v of result.violations) console.error(`  ${v.file} — ${v.reason}`);
    process.exit(1);
  }
}

// Only run the CLI when executed directly, so tests can import the pure functions.
if (isMain(import.meta.url)) main();
