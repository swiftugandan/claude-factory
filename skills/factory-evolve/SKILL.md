---
name: factory-evolve
description: Turn confirmed repeated failures into the smallest safe, versioned harness improvement.
disable-model-invocation: true
---

# Evolve the harness

Read:
- `.claude/factory/failures.jsonl`;
- relevant test output and incidents;
- `.claude/factory/factory.yaml`;
- current CLAUDE.md, skills, agents, hooks, and CI configuration.

For each selected failure:

1. Establish the actual failure mode using evidence.
2. Check whether the failure is repeated or high impact.
3. Add or update a regression test where feasible.
4. Choose one narrow prevention mechanism:
   - CLAUDE.md or rule for an always-on convention;
   - skill for a repeatable reasoning workflow;
   - subagent for specialized isolated work;
   - hook or CI rule for an invariant;
   - MCP integration for a missing external capability.
5. Create a mutation record under `.claude/factory/mutations/`.
6. Mark the ledger item triaged only after the regression or prevention mechanism exists.
7. Run the affected checks.

Never:
- replace a deterministic guardrail with prose;
- modify a guardrail to hide a failure;
- infer a production root cause from an unverified hypothesis;
- make a broad refactor when a narrow mutation suffices.

Return a before/after summary with:
- failure class;
- evidence;
- regression test;
- harness mutation;
- expected prevented recurrence;
- remaining risk.

## Mutation record format

Write records as `.claude/factory/mutations/YYYY-MM-DD-short-slug.yaml`:

```yaml
date: "2026-08-09"
status: proposed

trigger:
  type: escaped_defect
  symptom: duplicate customer record after request retry

evidence:
  - tests/regression/retried-create-request.test.ts
  - issue: "ENG-142"

root_cause:
  external write did not have an idempotency boundary

mutation:
  type: skill_and_regression_test
  changes:
    - add idempotency requirement to implementation workflow
    - add retry regression test

success_condition:
  duplicate delivery of the same request produces one logical record

owner_approval_required: true
```
