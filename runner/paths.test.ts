import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyChanges,
  globToRegExp,
  isGuarded,
  matchesAny,
  normalizePath,
  GUARDED_PREFIXES,
  HOOK_GUARDED_PREFIXES,
} from "./paths.ts";

test("globs respect directory boundaries", () => {
  assert.ok(globToRegExp("src/billing/**").test("src/billing/webhook.ts"));
  assert.ok(globToRegExp("src/billing/**").test("src/billing/deep/nested/file.ts"));
  assert.ok(!globToRegExp("src/billing/**").test("src/billing_legacy/file.ts"));
  assert.ok(!globToRegExp("src/billing/**").test("src/other/file.ts"));

  assert.ok(globToRegExp("*.md").test("README.md"));
  assert.ok(!globToRegExp("*.md").test("docs/README.md"));
  assert.ok(globToRegExp("**/*.md").test("docs/deep/README.md"));
  assert.ok(globToRegExp("**/*.md").test("README.md"));
});

test("a bare prefix does not swallow a sibling directory", () => {
  // The old shell fallback did a raw prefix match, so `src/bill` matched
  // `src/billing/secret.ts` and quietly widened the task's scope.
  assert.ok(!matchesAny("src/billing/secret.ts", ["src/bill"]));
  assert.ok(matchesAny("src/billing/secret.ts", ["src/billing/**"]));
});

test("paths are normalized before matching", () => {
  assert.equal(normalizePath("./src//a.ts"), "src/a.ts");
  assert.ok(matchesAny("./src/a.ts", ["src/**"]));
});

test("files inside allowed_paths pass", () => {
  const result = classifyChanges(
    ["src/billing/webhook.ts", "tests/billing/webhook.test.ts"],
    ["src/billing/**", "tests/billing/**"]
  );
  assert.deepEqual(result, { ok: true, violations: [] });
});

test("files outside allowed_paths are violations", () => {
  const result = classifyChanges(["src/auth/session.ts"], ["src/billing/**"]);
  assert.equal(result.ok, false);
  assert.match(result.violations[0].reason, /outside the task's allowed_paths/);
});

test("forbidden_paths carve a hole out of a broad allow", () => {
  // forbidden_paths existed in the schema and the example contract, and nothing
  // anywhere read it. A deny that is never evaluated is not a deny.
  const result = classifyChanges(
    ["src/billing/legacy/charge.ts"],
    ["src/billing/**"],
    ["src/billing/legacy/**"]
  );
  assert.equal(result.ok, false);
  assert.match(result.violations[0].reason, /forbidden_paths/);
});

test("harness paths are refused even when allowed_paths would permit them", () => {
  const guarded = [
    ".github/workflows/factory-ci.yml",
    ".claude/hooks/protect-harness.sh",
    ".claude/settings.json",
    ".claude/factory/factory.yaml",
    "runner/dispatcher.ts",
    "CODEOWNERS",
  ];
  const result = classifyChanges(guarded, ["**"]);
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, guarded.length);
  for (const violation of result.violations) {
    assert.match(violation.reason, /factory harness/);
  }
});

test("a guarded file prefix does not match an unrelated lookalike", () => {
  assert.ok(!isGuarded("runner-notes/todo.md"));
  assert.ok(!isGuarded("CODEOWNERS.md"));
  assert.ok(isGuarded("runner/paths.ts"));
});

test("empty lines in a diff are ignored", () => {
  assert.deepEqual(classifyChanges(["", "  ", "src/a.ts"], ["src/**"]), { ok: true, violations: [] });
});

test("the PreToolUse hook guards the same paths as the runner", () => {
  // Three layers enforce this boundary. If their lists drift, the system reads as
  // defended while one layer quietly allows what the others block.
  const script = readFileSync(new URL("../hooks/protect-harness.sh", import.meta.url), "utf8");
  const block = script.match(/guarded_prefixes=\(([\s\S]*?)\)/);
  assert.ok(block, "protect-harness.sh must declare a guarded_prefixes array");

  const fromScript = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(fromScript, [...HOOK_GUARDED_PREFIXES].sort());
});

test("factory.yaml is branch-guarded but hook-guarded only by its gate rule", () => {
  assert.ok(GUARDED_PREFIXES.includes(".claude/factory/factory.yaml"));
  assert.ok(!HOOK_GUARDED_PREFIXES.includes(".claude/factory/factory.yaml"));
});
