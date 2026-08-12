import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseYaml } from "./yaml.ts";
import {
  configFromDocument,
  loadConfig,
  atLeast,
  canClaimExplicit,
  canClaimFromQueue,
  canRepair,
  DEFAULT_CONFIG,
} from "./config.ts";

const template = () =>
  configFromDocument(
    parseYaml(readFileSync(new URL("../templates/factory.yaml", import.meta.url), "utf8"))
  );

test("the shipped template parses into a usable config", () => {
  const config = template();
  assert.equal(config.autonomy.level, "pr_only");
  assert.equal(config.autonomy.base_branch, "main");
  assert.equal(config.autonomy.ready_label, "factory:ready");
  assert.equal(config.autonomy.budgets.max_open_factory_prs, 5);
  assert.deepEqual(config.autonomy.auto_merge_allowed_classes, [
    "docs_only",
    "tests_only",
    "dependency_patch_with_passing_ci",
  ]);
});

test("TODO commands are treated as absent, never as configured", () => {
  // A gate that is not wired up must fail loudly at the point of use rather than
  // appearing to have run and passed.
  const config = template();
  assert.equal(config.commands.test, undefined);
  assert.equal(Object.keys(config.commands).length, 0);

  const wired = configFromDocument(parseYaml("commands:\n  test: npm test\n  lint: TODO\n"));
  assert.equal(wired.commands.test, "npm test");
  assert.equal(wired.commands.lint, undefined);
});

test("quality gates are read as booleans", () => {
  const config = template();
  assert.equal(config.quality_gates.require_human_approval_for_production_deploy, true);
  assert.equal(config.quality_gates.require_tests_for_behavior_change, true);
});

test("a missing manifest fails closed at level 'off'", () => {
  const config = loadConfig("/nonexistent/factory.yaml");
  assert.equal(config.autonomy.level, "off");
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test("an unreadable manifest throws rather than defaulting to permissive", () => {
  assert.throws(() => configFromDocument(parseYaml("autonomy:\n  level: yolo\n")), /not one of/);
});

test("the autonomy ladder is ordered and enforced", () => {
  assert.ok(atLeast("queue", "repair"));
  assert.ok(!atLeast("pr_only", "repair"));
  assert.ok(atLeast("automerge", "off"));

  // Scheduled claiming is a strictly larger grant than a human naming one task.
  assert.equal(canClaimExplicit("pr_only"), true);
  assert.equal(canClaimFromQueue("pr_only"), false);
  assert.equal(canClaimFromQueue("queue"), true);

  assert.equal(canRepair("pr_only"), false);
  assert.equal(canRepair("repair"), true);

  // 'off' grants nothing at all.
  assert.equal(canClaimExplicit("off"), false);
  assert.equal(canClaimFromQueue("off"), false);
  assert.equal(canRepair("off"), false);
});

test("unknown autonomy keys fall back to defaults instead of undefined", () => {
  const config = configFromDocument(parseYaml("autonomy:\n  level: repair\n"));
  assert.equal(config.autonomy.level, "repair");
  assert.equal(config.autonomy.base_branch, "main");
  assert.equal(config.autonomy.budgets.default_max_attempts, 2);
});
