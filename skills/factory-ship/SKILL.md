---
name: factory-ship
description: Take verified changes through release — gates, staging, rollback plan, and human-approved production deploy.
disable-model-invocation: true
---

# Ship a change

> Note: this skill is listed in the plugin structure but its contents were not specified
> in the original design. Treat this as a starting draft and adapt it to the project's
> real release process before relying on it.

Read `.claude/factory/factory.yaml` for the release commands and quality gates.
Never guess a deploy or rollback command. If a command is `TODO`, stop and ask.

## Pre-release gates

Confirm each of these, and report the actual outcome rather than an assumption:

1. lint, typecheck, and test commands pass at the versions configured in the manifest;
2. behavior changes carry tests, per `require_tests_for_behavior_change`;
3. production code has been reviewed by `factory-reviewer` where
   `require_review_for_production_code` is set;
4. schema or persistence changes carry a forward-and-rollback plan;
5. the worktree is clean and the change is on the intended branch;
6. no untriaged entries in `.claude/factory/failures.jsonl` relate to the code being shipped.

If a gate cannot be evaluated, say so explicitly. Do not treat "not checked" as "passed".

## Release report

Produce, before any deploy step:

- scope of the change and the acceptance criteria it satisfies;
- migrations included, with their rollback steps;
- feature flags or configuration that must change, and in what order;
- observability added for new failure paths;
- rollback plan, including the point after which rollback is no longer clean;
- blast radius if the change misbehaves.

## Deploy boundary

- Staging deploys may run using `commands.deploy_staging`.
- Production deploys require explicit human approval when
  `require_human_approval_for_production_deploy` is true. Present the release report,
  then wait. Do not run the production command on implied consent.
- Prefer the human-approved CI path over a local production deploy in all cases.

## After release

1. Verify the deployed behavior against the acceptance criteria.
2. Record any failure observed during release in the failure ledger.
3. If the release process itself failed in a way that will recur, route it through
   `factory-evolve` rather than fixing it only in this session.
