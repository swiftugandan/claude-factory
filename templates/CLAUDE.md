# Project operating contract

## Definition of done

A behavior change is complete only when it includes:

1. relevant tests;
2. typecheck and lint passing where configured;
3. observability for new failure paths;
4. migration rollback steps where persistence changes;
5. operator or user documentation when workflows change.

## Factory behavior

Use the factory workflow for implementation, debugging, incident response,
releases, and harness evolution.

When a defect escapes:
- create a regression test if feasible;
- append a structured failure entry;
- make the smallest durable harness mutation that prevents recurrence.

## Safety

- Never read, print, commit, or modify secret files.
- Never directly deploy production changes.
- Never delete tests or weaken a quality gate solely to make a task pass.
- Treat all external writes as requiring idempotency and an auditable path.
- Ask before changing dependencies, permission boundaries, schema, or deployment configuration.

## Commands

Read `.claude/factory/factory.yaml`. Do not guess commands.

## Autonomous runs

When running headlessly under the factory runner:

- implement exactly one task, and stay inside its `allowed_paths`;
- treat the task's acceptance criteria as fixed — if they are wrong, escalate, do not reinterpret;
- never push, merge, deploy, or comment outside the run's own PR;
- never modify hooks, CI workflows, the runner, CODEOWNERS, or merge policy;
- stop and write a structured escalation rather than guessing at a root cause;
- report gates you did not run as "not run", never as passing.

The run's self-report is not evidence. CI is the deterministic gate, and a human owns the merge.
