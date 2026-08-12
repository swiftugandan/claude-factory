import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseTaskContract, claimBlockers, type Task } from "./contract.ts";

const CONTRACT = `
id: ENG-142
title: Add webhook idempotency
status: ready
owner: "@payments-team"

acceptance_criteria:
  - duplicate event delivery creates one logical record
  - invalid signatures are rejected

allowed_paths:
  - src/billing/**
  - tests/billing/**

risk:
  level: medium
  requires_human_merge: true

budget:
  max_runtime_minutes: 30
  max_attempts: 2
`;

const body = (yaml: string) => ["Some preamble.", "```yaml", yaml.trim(), "```"].join("\n");

test("parses a well-formed contract out of an issue body", () => {
  const { task, problems } = parseTaskContract(body(CONTRACT));
  assert.deepEqual(problems, []);
  assert.equal(task?.id, "ENG-142");
  assert.equal(task?.budget.max_runtime_minutes, 30);
  assert.deepEqual(task?.allowed_paths, ["src/billing/**", "tests/billing/**"]);
});

test("the shipped example contract is claimable", () => {
  // The template is documentation people copy. If it does not validate, every task
  // authored from it is unclaimable and the failure looks like the dispatcher's fault.
  const example = readFileSync(
    new URL("../templates/queue/ENG-142.example.yaml", import.meta.url),
    "utf8"
  );
  const { task, problems } = parseTaskContract(body(example));
  assert.deepEqual(problems, []);
  assert.equal(task?.id, "ENG-142");
});

test("an example block above the real contract does not get claimed", () => {
  // Issue templates routinely carry a sample. Claiming the sample is worse than
  // claiming nothing, because the run looks legitimate all the way to the PR.
  const example = "id: EXAMPLE\nstatus: draft\ntitle: sample\n";
  const markdown = [
    "Here is the shape:",
    "```yaml",
    example.trim(),
    "```",
    "And the actual task:",
    "```yaml",
    CONTRACT.trim(),
    "```",
  ].join("\n");

  const { task } = parseTaskContract(markdown);
  assert.equal(task?.id, "ENG-142");
});

test("a body with no contract is reported, not guessed at", () => {
  const { task, problems } = parseTaskContract("Please make the webhooks better, thanks!");
  assert.equal(task, null);
  assert.match(problems.join(), /no fenced/);
});

test("an incomplete contract reports every problem", () => {
  const { task, problems } = parseTaskContract(
    body("id: ENG-9\nstatus: ready\ntitle: vague idea\n")
  );
  assert.equal(task, null);
  assert.match(problems.join(), /acceptance_criteria/);
  assert.match(problems.join(), /allowed_paths/);
  assert.match(problems.join(), /budget/);
});

test("an unterminated yaml block is named, not silently ignored", () => {
  // The extractor cannot see an unclosed block at all. Without an explicit check the
  // reported problems describe whichever block *was* found, sending the author to
  // edit the wrong text — which is exactly what happened the first time this ran.
  const markdown = [
    "Reference shape:",
    "```yaml",
    "id: EXAMPLE",
    "status: draft",
    "```",
    "Actual task:",
    "```yaml",
    CONTRACT.trim(), // no closing fence
  ].join("\n");

  const { task, problems } = parseTaskContract(markdown);
  assert.equal(task, null);
  assert.match(problems.join(" "), /unterminated/);
  assert.match(problems.join(" "), /closing fence/);
});

test("a closed body reports no unterminated-fence problem", () => {
  const { problems } = parseTaskContract(body("id: X\nstatus: ready\n"));
  assert.doesNotMatch(problems.join(" "), /unterminated/);
});

test("validation problems name the block they came from", () => {
  const { problems } = parseTaskContract(body("id: ENG-9\nstatus: ready\ntitle: vague\n"));
  assert.match(problems.join(" "), /block 1/);
});

test("a malformed yaml block is a parse problem, not a crash", () => {
  const { task, problems } = parseTaskContract(body("id: ENG-9\n\tstatus: ready\n"));
  assert.equal(task, null);
  assert.ok(problems.length > 0);
});

test("a non-ready task is not claimable", () => {
  const task = { ...(parseTaskContract(body(CONTRACT)).task as Task), status: "draft" as const };
  assert.match(claimBlockers(task).join(), /expected 'ready'/);
});

test("an exhausted attempt budget blocks a claim", () => {
  const base = parseTaskContract(body(CONTRACT)).task as Task;
  assert.deepEqual(claimBlockers({ ...base, attempts: 1 }), []);
  assert.match(claimBlockers({ ...base, attempts: 2 }).join(), /attempt budget exhausted/);
  assert.match(claimBlockers({ ...base, attempts: 5 }).join(), /attempt budget exhausted/);
});
