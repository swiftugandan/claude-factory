---
name: factory-open-pr
description: Push the task branch and open a draft pull request carrying test evidence and rollback notes.
disable-model-invocation: true
---

# Open a pull request for a factory run

A factory PR exists to be reviewed by a human or a merge policy. Its job is to make the
evidence inspectable, not to argue that the change is good.

## Preconditions

Refuse to open the PR if any of these is false, and say which:

- the configured quality gates ran, and you can state their actual outcome;
- every changed file falls inside the task's `allowed_paths`;
- the commit message follows `factory(<TASK_ID>): <concise summary>`;
- no test was deleted, skipped, or weakened in this branch;
- no hook, CI workflow, permission, or deploy configuration was modified.

Push the branch. Open the PR as a **draft**. Never merge, and never enable auto-merge.

## PR body

```md
## Task
<TASK_ID> — <title>
Link to the source issue.

## Acceptance criteria
- [x] criterion, with the test or observation that demonstrates it
- [ ] criterion not met, with the reason

## Changes
Files changed and why, grouped by concern. Note anything a reviewer would not expect.

## Verification
The exact commands run and their real outcomes. Paste failing output verbatim if a gate
did not pass. Say "not run" where a gate could not run, and why — never imply a gate passed
that you did not execute.

## Risk and rollback
Blast radius, migrations with their rollback steps, feature flags and the order to change
them, observability added for new failure paths, and the point after which rollback is no
longer clean.

## Open questions
Decisions a human needs to make.
```

## Attempts and evidence

Attach or link the run transcript from `.claude/factory/runs/<TASK_ID>.json`. If the run
went through `/factory-repair`, say so and state which gate failed initially — a PR that
needed repair is a different review object than one that passed first time.

## After opening

Do not comment further on the PR unless a check result changes. Do not respond to review
comments in the same autonomous run; a new review comment is a new bounded task.
