---
name: factory-repair
description: Make one bounded correction against a concrete failing check, or escalate with structured evidence.
disable-model-invocation: true
---

# Repair a failed factory run

This is a **bounded** repair, not a retry loop. You get one correction attempt per invocation,
and the run stops after `budget.max_attempts` attempts total.

## Read first

- the task contract in `.claude/factory/queue/<TASK_ID>.json`;
- the current diff (`git diff origin/main...HEAD`);
- the failing test or gate output — the actual output, not a summary of it;
- `.claude/factory/failures.jsonl`;
- `.claude/factory/factory.yaml` for the commands to re-run.

## Rules

Make the smallest correction that addresses the observed failure.

- Do not change the acceptance criteria.
- Do not delete, skip, quarantine, `.only`, `.skip`, or otherwise weaken a failing test.
- Do not widen `allowed_paths` to reach a file the task did not scope.
- Do not change hooks, merge policy, CI permissions, or deployment configuration.
- Do not fix a symptom you cannot explain. If the failure output does not support a
  root cause, escalate instead of guessing.

Re-run the targeted check only. Run the broader suite only if shared behavior changed.

## If it passes

Amend or add a commit, note in the run report which gate failed and what corrected it,
and append the failure to the ledger with `triaged: false` — a repaired failure is still
evidence for `/factory-evolve`.

## If it fails again

Stop. Do not attempt a third fix. Produce an escalation artifact at
`.claude/factory/runs/<TASK_ID>-escalation.yaml`:

```yaml
task: ENG-142
status: blocked
attempts: 2
failed_gate: integration_test
evidence:
  - run: .claude/factory/runs/ENG-142-attempt-2.json
  - test_log: artifacts/ENG-142/integration.log
hypothesis: webhook sandbox credentials unavailable in CI
requested_human_decision: provide test credential or revise integration boundary
```

The `hypothesis` field is a hypothesis. Mark it as unverified if you could not test it.
State plainly what decision or information you need — the goal is not to never ask a human,
it is to only ask when an authority decision or missing information is genuinely required.
