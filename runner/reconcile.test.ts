import { test } from "node:test";
import assert from "node:assert/strict";

import { decide, type DecisionInput } from "./reconcile.ts";

const input = (overrides: Partial<DecisionInput> = {}): DecisionInput => ({
  status: "claimed",
  attempts: 1,
  maxAttempts: 2,
  ageMinutes: 200,
  graceMinutes: 120,
  branchHasWork: false,
  ...overrides,
});

test("a fresh claim is left alone", () => {
  // The old reconciler treated a missing timestamp as infinitely stale, which would
  // yank a task away from a run that started thirty seconds earlier.
  const decision = decide(input({ ageMinutes: 5 }));
  assert.equal(decision.action, "skip");
  assert.match(decision.reason, /grace window/);
});

test("a stale claim with budget left is released", () => {
  const decision = decide(input({ ageMinutes: 200, attempts: 1, maxAttempts: 2 }));
  assert.equal(decision.action, "release");
});

test("a stale claim with no budget left is blocked, not retried forever", () => {
  assert.equal(decide(input({ attempts: 2, maxAttempts: 2 })).action, "block");
  assert.equal(decide(input({ attempts: 3, maxAttempts: 2 })).action, "block");
});

test("evidence on a branch goes to review rather than a retry", () => {
  // A retry would rebase over work a human has not seen yet.
  const decision = decide(input({ branchHasWork: true }));
  assert.equal(decision.action, "review");
  assert.match(decision.reason, /branch/);
});

test("a branch outranks an exhausted budget", () => {
  assert.equal(decide(input({ branchHasWork: true, attempts: 9 })).action, "review");
});

test("a reported failure is acted on immediately, with no grace period", () => {
  // The runner already told us the run ended. Waiting out the timeout budget would
  // leave the task invisible for another two hours for no information gain.
  const decision = decide(input({ status: "failed", ageMinutes: 1 }));
  assert.equal(decision.action, "release");
  assert.match(decision.reason, /run failed/);
});

test("a failed run with no budget left is blocked immediately", () => {
  assert.equal(decide(input({ status: "failed", ageMinutes: 1, attempts: 2 })).action, "block");
});

test("terminal states are never reopened", () => {
  for (const status of ["in_review", "blocked", "done"] as const) {
    const decision = decide(input({ status, ageMinutes: 100_000, branchHasWork: true }));
    assert.equal(decision.action, "skip", `${status} should be left alone`);
    assert.match(decision.reason, new RegExp(status));
  }
});

test("a running claim past its grace window is treated as dead", () => {
  assert.equal(decide(input({ status: "running", ageMinutes: 500 })).action, "release");
});

test("reconcile never raises a budget", () => {
  // Every decision is a function of the recorded attempts; none of them writes one back.
  const decisions = [
    decide(input({ attempts: 0 })),
    decide(input({ attempts: 1 })),
    decide(input({ attempts: 2 })),
  ];
  assert.deepEqual(decisions.map((d) => d.action), ["release", "release", "block"]);
});
