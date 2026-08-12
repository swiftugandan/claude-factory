import { test } from "node:test";
import assert from "node:assert/strict";

import { parseYaml, parseScalar, fencedYamlBlocks, YamlError } from "./yaml.ts";

test("parses nested mappings and sequences", () => {
  const doc = parseYaml(`
id: ENG-142
title: Add webhook idempotency
acceptance_criteria:
  - duplicate event delivery creates one logical record
  - invalid signatures are rejected
risk:
  level: medium
  requires_human_merge: true
budget:
  max_runtime_minutes: 30
  max_attempts: 2
`);
  assert.deepEqual(doc, {
    id: "ENG-142",
    title: "Add webhook idempotency",
    acceptance_criteria: [
      "duplicate event delivery creates one logical record",
      "invalid signatures are rejected",
    ],
    risk: { level: "medium", requires_human_merge: true },
    budget: { max_runtime_minutes: 30, max_attempts: 2 },
  });
});

test("keeps nesting instead of flattening it", () => {
  // The previous hand-rolled parser collapsed every indented line into one level,
  // so a nested budget silently became a sibling of the task's top-level keys.
  const doc = parseYaml("a:\n  b:\n    c: 1\n") as Record<string, Record<string, unknown>>;
  assert.deepEqual(doc, { a: { b: { c: 1 } } });
});

test("scalars keep their types", () => {
  assert.equal(parseScalar("true"), true);
  assert.equal(parseScalar("false"), false);
  assert.equal(parseScalar("null"), null);
  assert.equal(parseScalar("~"), null);
  assert.equal(parseScalar("30"), 30);
  assert.equal(parseScalar("-1.5"), -1.5);
  assert.equal(parseScalar('"30"'), "30");
  assert.equal(parseScalar("'it''s'"), "it's");
  assert.equal(parseScalar("src/**"), "src/**");
});

test("a version-like value stays a string", () => {
  const doc = parseYaml("version: 1.2.3\ncount: 1.5\n");
  assert.deepEqual(doc, { version: "1.2.3", count: 1.5 });
});

test("strips comments but not '#' inside quotes or urls", () => {
  const doc = parseYaml(`
# leading comment
id: ENG-1   # trailing comment
note: "a # b"
url: https://example.com/docs#anchor
`);
  assert.deepEqual(doc, {
    id: "ENG-1",
    note: "a # b",
    url: "https://example.com/docs#anchor",
  });
});

test("a url value is not mistaken for a nested mapping", () => {
  const doc = parseYaml("context:\n  - https://example.com/a\n  - docs/runbook.md\n");
  assert.deepEqual(doc, { context: ["https://example.com/a", "docs/runbook.md"] });
});

test("supports inline flow sequences", () => {
  assert.deepEqual(parseYaml('allowed_paths: ["src/**", "tests/**"]'), {
    allowed_paths: ["src/**", "tests/**"],
  });
  assert.deepEqual(parseYaml("forbidden_paths: []"), { forbidden_paths: [] });
});

test("a key with no value is null, not an empty object", () => {
  assert.deepEqual(parseYaml("owner:\nid: X\n"), { owner: null, id: "X" });
});

test("rejects rather than guesses on unsupported or malformed input", () => {
  // Silently mis-parsing a contract is worse than refusing to claim it.
  assert.throws(() => parseYaml("body: |\n  multi\n  line\n"), YamlError);
  assert.throws(() => parseYaml("steps:\n  - name: a\n    run: b\n"), YamlError);
  assert.throws(() => parseYaml("a: 1\n\tb: 2\n"), YamlError);
  assert.throws(() => parseYaml("id: A\nid: B\n"), YamlError);
  assert.throws(() => parseYaml("risk: {level: low}"), YamlError);
  assert.throws(() => parseYaml("just a bare string"), YamlError);
});

test("refuses prototype-polluting keys", () => {
  assert.throws(() => parseYaml("__proto__:\n  polluted: true\n"), YamlError);
});

test("extracts every fenced yaml block in order", () => {
  const body = [
    "Some text",
    "```yaml",
    "id: EXAMPLE",
    "```",
    "More text",
    "```yml",
    "id: REAL",
    "```",
  ].join("\n");
  assert.deepEqual(fencedYamlBlocks(body), ["id: EXAMPLE\n", "id: REAL\n"]);
});

test("ignores fenced blocks of other languages", () => {
  assert.deepEqual(fencedYamlBlocks("```json\n{}\n```"), []);
});
