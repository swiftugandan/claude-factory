import { test } from "node:test";
import assert from "node:assert/strict";

import { validate } from "./schema.ts";
import { taskSchema } from "./contract.ts";

const validTask = {
  id: "ENG-142",
  title: "Add webhook idempotency",
  status: "ready",
  owner: "@payments-team",
  acceptance_criteria: ["duplicate delivery creates one record"],
  allowed_paths: ["src/billing/**"],
  risk: { level: "medium" },
  budget: { max_runtime_minutes: 30, max_attempts: 2 },
};

test("a fully specified task validates", () => {
  assert.deepEqual(validate(validTask, taskSchema()), []);
});

test("the shipped example contract validates", () => {
  assert.deepEqual(
    validate(
      {
        ...validTask,
        forbidden_paths: ["src/billing/legacy/**"],
        context: ["docs/runbooks/stripe-webhooks.md"],
        risk: {
          level: "medium",
          requires_human_merge: true,
          requires_human_deploy: true,
          touches_schema: false,
          touches_external_writes: true,
        },
      },
      taskSchema()
    ),
    []
  );
});

test("missing required fields are reported, not defaulted", () => {
  const { acceptance_criteria, ...withoutCriteria } = validTask;
  const problems = validate(withoutCriteria, taskSchema());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /acceptance_criteria/);
});

test("an owner is required, because an escalation needs an addressee", () => {
  const { owner, ...withoutOwner } = validTask;
  assert.match(validate(withoutOwner, taskSchema()).join(), /owner/);
});

test("empty acceptance criteria are rejected", () => {
  assert.match(
    validate({ ...validTask, acceptance_criteria: [] }, taskSchema()).join(),
    /at least 1 item/
  );
});

test("unknown properties are rejected rather than ignored", () => {
  assert.match(
    validate({ ...validTask, auto_merge: true }, taskSchema()).join(),
    /unexpected property 'auto_merge'/
  );
});

test("budget bounds are enforced", () => {
  assert.match(
    validate({ ...validTask, budget: { max_runtime_minutes: 999, max_attempts: 2 } }, taskSchema()).join(),
    /above maximum 120/
  );
  assert.match(
    validate({ ...validTask, budget: { max_runtime_minutes: 30, max_attempts: 99 } }, taskSchema()).join(),
    /above maximum 3/
  );
});

test("the id pattern is enforced, since it becomes a branch and a path", () => {
  assert.match(validate({ ...validTask, id: "../../etc/passwd" }, taskSchema()).join(), /does not match/);
  assert.match(validate({ ...validTask, id: "with space" }, taskSchema()).join(), /does not match/);
});

test("enums are enforced", () => {
  assert.match(validate({ ...validTask, status: "almost" }, taskSchema()).join(), /is not one of/);
  assert.match(
    validate({ ...validTask, risk: { level: "critical" } }, taskSchema()).join(),
    /is not one of/
  );
});

test("type mismatches short-circuit instead of cascading", () => {
  const problems = validate({ ...validTask, acceptance_criteria: "one thing" }, taskSchema());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /expected array, got string/);
});

test("unsupported schema keywords fail loudly at construction", () => {
  // A keyword that silently does nothing is how a contract quietly stops being enforced.
  assert.throws(() => validate({}, { type: "object", oneOf: [] }), /unsupported keyword 'oneOf'/);
});
