# claude-factory

A Claude Code plugin that installs a project-local operating harness: a factory skill,
specialist subagents, enforced hooks, a failure ledger, and a promotion path from one-off
fixes to reusable capability.

This is not a second autonomous system sitting above Claude Code. It is a Claude Code-native
factory: Claude is the worker; the repository is its evolving workshop.

## Install

`claude plugin install` resolves plugins from marketplaces, not from paths or URLs, so add
this repo as one first. It ships its own single-plugin marketplace manifest:

```bash
claude plugin marketplace add swiftugandan/claude-factory
claude plugin install claude-factory@swiftugandan-factory
```

Restart Claude Code, then confirm it loaded:

```bash
claude plugin list          # claude-factory should appear
```

Working on the harness itself? Point the marketplace at your checkout instead, so edits
take effect on restart without a round trip through GitHub:

```bash
claude plugin marketplace add /path/to/claude-factory
```

To back either out: `claude plugin uninstall claude-factory` and
`claude plugin marketplace remove swiftugandan-factory`.

Then, in any Claude-built project:

```text
/factory-bootstrap
```

The bootstrap creates the project-local files Claude will actually use — `.claude/factory/factory.yaml`,
the failure ledger, the hooks, and a `CLAUDE.md` operating contract.

## Use

```text
/factory Implement passwordless sign-in for existing accounts.
```

Or make it the project's default working model in `CLAUDE.md`:

```md
For implementation, debugging, release, and operational work, use the factory workflow.
```

When a defect escapes to production:

```text
/factory-evolve Investigate the duplicate subscription incident in ENG-142.
```

The durable output is not "Claude will remember to use idempotency." It is a regression test,
an explicit implementation-workflow requirement, possibly a static check around external writes,
and a recorded mutation reviewers can inspect.

## Contents

| Path | Purpose |
|---|---|
| `skills/factory/` | The main implementation loop and mutation-routing rules |
| `skills/factory-bootstrap/` | One-time install of the project-local harness |
| `skills/factory-evolve/` | Turns confirmed failures into the narrowest durable fix |
| `skills/factory-ship/` | Release gates, rollback planning, approval boundary |
| `skills/factory-repair/` | One bounded correction against a concrete failing gate |
| `skills/factory-open-pr/` | Draft PR carrying evidence and rollback notes |
| `runner/` | Dispatcher, headless task runner, queue reconciler, and their tests |
| `.github/workflows/` | Scheduled dispatcher and the deterministic CI gate |
| `agents/` | Read-only reviewer, test engineer, and incident investigator |
| `hooks/` | Protected paths, dangerous commands, failure capture, dirty worktree |
| `templates/` | `CLAUDE.md`, `factory.yaml`, task and escalation contracts, empty ledger |

The runner has its own test suite, because it decides whether a branch may be pushed:

```bash
npm install && npm test
```

## Hooks

Hooks matter because they enforce actions deterministically rather than trusting the agent to
remember them. Hooks receive structured JSON on stdin; a `PreToolUse` hook blocks an action by
writing to stderr and exiting with code `2`.

The bootstrap merges `hooks/hooks.json` into the project's `.claude/settings.json` rather than
replacing existing hooks, and copies the scripts to `.claude/hooks/` with the executable bit set.

`protect-harness.sh` blocks edits to hooks, CI workflows, the runner, CODEOWNERS, and any change
that flips a quality gate in `factory.yaml` to `false`. The agent may propose harness changes
through a separately reviewed PR; it may not make them mid-run.

`capture-failure.sh` runs on `PostToolUse` and decides for itself whether the call failed,
recording the tool, the invocation, and the actual error text. It is observational and never
blocks. The hook scripts require `jq` and `bash`. `check-dirty-worktree.sh` is advisory only — it
reports an uncommitted worktree at session end and never blocks or commits.

Do not auto-approve broad permissions in interactive use. A factory should tighten the action
boundary, not silently grant itself more access. The one exception is the headless runner, where
prompts cannot be answered at all — see [AUTONOMY.md](AUTONOMY.md#why-the-headless-run-bypasses-permission-prompts)
for why that is contained rather than an exception to the rule.

## Autonomous delivery

The plugin runs interactively out of the box. To run development continuously, see
[AUTONOMY.md](AUTONOMY.md): a dispatcher claims one ready issue per tick, runs it headlessly
in a fresh worktree under a hard timeout, and opens a draft PR. CI is the deterministic gate;
a human owns the merge.

```bash
npx tsx runner/dispatcher.ts --label "factory:ready"
./runner/run-task.sh ENG-142
npx tsx runner/reconcile.ts --dry-run
```

Durable state lives on the GitHub issue — a label plus one machine-readable comment — never in
the workspace, which CI recreates empty on every tick.

> **The scheduled dispatcher ships disabled.** The `cron` trigger in
> [`.github/workflows/factory-dispatch.yml`](.github/workflows/factory-dispatch.yml) is
> commented out, so a fresh clone claims nothing on its own — dispatch runs start from the
> Actions tab, by a human. Scheduled claiming is the `queue` autonomy level, and moving there
> is a decision you make after watching real failure modes at the levels below it.
>
> Re-enabling takes two independent changes, on purpose: uncomment the `cron` line **and** set
> `autonomy.level: queue` in `.claude/factory/factory.yaml`. Either one alone is inert, so a
> stray edit to a workflow file cannot by itself put the factory on a timer.

Start at `autonomy.level: pr_only` in `factory.yaml` and move a level only after watching real
failure modes at the current one. The level is enforced by the runner, not just documented: at
`pr_only` a scheduled tick claims nothing, and a missing manifest resolves to `off`. Long-running
autonomy should be a sequence of short, resumable jobs with durable artifacts — not one session
kept alive for days.

## Extending with MCP

Add MCP only when the factory needs real external evidence or action:

```text
GitHub MCP      -> issues, PRs, CI state
Sentry MCP      -> error groups, traces, releases
Linear/Jira MCP -> draft work items and incident tracking
Database MCP    -> read-only diagnosis
Cloud MCP       -> logs and deployment status, initially read-only
```

Pair each write-capable MCP tool with a skill and an approval boundary. MCP provides connectivity;
the factory skill supplies the safe workflow for using it.

## Scope

**Interactive core:** `/factory`, `/factory-bootstrap`, `/factory-evolve`, three subagents,
protected-path and dangerous-command hooks, a failure ledger, and regression tests. That is enough
to turn Claude Code from an agent that edits code into a project that learns how to build itself
more reliably with every verified failure.

**Autonomous layer:** a durable queue, isolated worktrees, CI-driven verification, a bounded
repair loop, and explicit human approval boundaries around merge and deploy.

## Reference

- [Claude Code extension model](https://code.claude.com/docs/en/features-overview)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks-guide)

## License

MIT — see [LICENSE](LICENSE).
