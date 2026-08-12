---
name: factory-bootstrap
description: Install the project-local Claude Factory harness into the current repository.
disable-model-invocation: true
---

# Bootstrap a Claude Factory project

Inspect the repository before editing. Detect:
- language and package manager;
- test command;
- typecheck/lint command;
- build command;
- deployment configuration;
- migration directories;
- existing CLAUDE.md and .claude configuration.

Create, without overwriting existing team guidance:

```text
.claude/
  factory/
    factory.yaml
    failures.jsonl
    mutations/
    queue/
    runs/
  hooks/
  evals/
    regression/
    acceptance/
  skills/
  agents/
```

Then:

1. Create or extend CLAUDE.md using the project template in `templates/CLAUDE.md`.
2. Write `.claude/factory/factory.yaml` from `templates/factory.yaml` with verified commands only.
3. Copy the safe default hooks from this plugin's `hooks/` directory into `.claude/hooks/`,
   make them executable, and merge the entries from `hooks/hooks.json` into the project's
   `.claude/settings.json` rather than replacing existing hooks.
4. Add a `docs/runbooks/` directory if one is absent.
5. Create an initial acceptance test placeholder only if no test structure exists.
6. Print a concise setup report and identify commands that still need human confirmation.

Never invent build, test, deploy, or rollback commands. Mark unknown values as `TODO`.
A `TODO` command is read as absent everywhere, so the gate fails loudly instead of
appearing to have passed.

## Only when the project will run autonomously

Skip this section for interactive-only use; it installs machinery that is dead weight
otherwise.

7. Copy `runner/` into the repository root, and copy `.github/workflows/factory-ci.yml`
   and `.github/workflows/factory-dispatch.yml` into `.github/workflows/`. The runner is
   vendored rather than resolved from the plugin because CI checks the repository out and
   `hooks/protect-harness.sh` guards `runner/` by path.
8. Ensure the runner's own dependencies are declared. If the project has no `package.json`,
   copy this plugin's. If it has one, add `tsx` and `typescript` to `devDependencies` and
   a `factory:test` script running `node --import tsx --test runner/*.test.ts`. Do not
   overwrite existing scripts.
9. Verify the runner works here before trusting it: run its test suite and
   `npx tsx runner/level.ts`. Report the level it prints — the template ships `pr_only`,
   which deliberately refuses scheduled claiming until a human raises it.
10. Report what the operator still has to do themselves, and do not do these for them:
    - create the `factory:ready`, `factory:claimed`, `factory:needs-review`, and
      `factory:blocked` labels;
    - add the `ANTHROPIC_API_KEY` repository secret;
    - protect the base branch and require the `Factory CI / gates`,
      `Factory CI / harness-tests`, and `Factory CI / harness-integrity` checks.

Autonomous runs keep their durable state on the GitHub issue — labels plus a single
machine-readable comment — never in the workspace. `.claude/factory/queue/` and
`.claude/factory/runs/` are per-run caches; add them to `.gitignore` rather than
committing them.
