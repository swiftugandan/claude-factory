#!/usr/bin/env -S npx -y tsx
/**
 * Dispatcher: claim exactly one ready task and hand it to the runner.
 *
 * Deliberate properties:
 *  - claims ONE task per invocation, so blast radius is one branch at a time;
 *  - refuses tasks that do not satisfy `runner/task-schema.json`;
 *  - the claim is durable on the issue (label + state comment), never in the workspace,
 *    so a crashed run is still visible to the reconciler on the next tick;
 *  - respects `autonomy.level` and `max_open_factory_prs` from factory.yaml;
 *  - never creates work. It only selects work a human already marked ready.
 *
 * Usage:
 *   npx tsx runner/dispatcher.ts --label "factory:ready"
 *   npx tsx runner/dispatcher.ts --task ENG-142     # claim a specific task
 *   npx tsx runner/dispatcher.ts --dry-run
 *
 * Exit codes:
 *   0  a task was claimed; id on stdout, FACTORY_TASK_ID appended to $GITHUB_ENV
 *   3  no ready task available (not an error — the scheduler treats this as a no-op)
 *   1  a real failure
 */

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { ghJson, relabel, tryComment } from "./gh.ts";
import { argValue, hasFlag, isMain } from "./cli.ts";
import { parseTaskContract, claimBlockers, type Task } from "./contract.ts";
import { loadConfig, canClaimFromQueue, canClaimExplicit } from "./config.ts";
import { readState, writeState } from "./state.ts";

const QUEUE_DIR = ".claude/factory/queue";
const RUNS_DIR = ".claude/factory/runs";
const NO_WORK = 3;

interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  createdAt?: string;
}

/** The workflow run that is making this claim, for attribution in the state comment. */
function runUrl(): string {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : "local";
}

function openFactoryPrCount(): number {
  try {
    const prs = ghJson<Array<{ headRefName: string }>>([
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "headRefName",
    ]);
    return prs.filter((pr) => pr.headRefName.startsWith("factory/")).length;
  } catch (err) {
    // Fail closed: if the cap cannot be evaluated, do not claim more work.
    throw new Error(`could not count open factory PRs: ${(err as Error).message}`);
  }
}

function findIssues(explicit: string | undefined, label: string): Issue[] {
  const query = explicit
    ? ["issue", "list", "--search", explicit, "--state", "open", "--limit", "5",
       "--json", "number,title,body,url,createdAt"]
    : ["issue", "list", "--label", label, "--state", "open", "--limit", "20",
       "--json", "number,title,body,url,createdAt"];
  const issues = ghJson<Issue[]>(query);
  // Oldest first: FIFO is predictable and avoids starving an unglamorous task.
  // Sorted here rather than by `--search sort:`, which cannot be combined with --label.
  return issues.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

function main(): void {
  const config = loadConfig();
  const level = config.autonomy.level;
  const explicit = argValue("task");
  const label = argValue("label") ?? config.autonomy.ready_label;
  const dryRun = hasFlag("dry-run");

  const allowed = explicit ? canClaimExplicit(level) : canClaimFromQueue(level);
  if (!allowed) {
    const required = explicit ? "pr_only" : "queue";
    console.error(
      `dispatcher: autonomy.level is '${level}'; ${explicit ? "explicit" : "scheduled"} ` +
        `claiming requires at least '${required}'. Nothing claimed.`
    );
    process.exit(NO_WORK);
  }

  const cap = config.autonomy.budgets.max_open_factory_prs;
  const open = openFactoryPrCount();
  if (open >= cap) {
    console.error(
      `dispatcher: ${open} open factory PR(s) at the cap of ${cap}. ` +
        `Review or close one before the factory takes more work.`
    );
    process.exit(NO_WORK);
  }

  let issues: Issue[];
  try {
    issues = findIssues(explicit, label);
  } catch (err) {
    console.error(`dispatcher: could not query issues: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!issues.length) {
    console.error(`dispatcher: no open issues matching ${explicit ?? `label '${label}'`}`);
    process.exit(NO_WORK);
  }

  for (const issue of issues) {
    const { task, problems, blockIndex } = parseTaskContract(issue.body ?? "");
    if (!task) {
      console.error(
        `dispatcher: #${issue.number} is not claimable` +
          (blockIndex === null ? "" : ` (yaml block ${blockIndex + 1})`) +
          `: ${problems.join("; ")}`
      );
      continue;
    }

    // Attempts live on the issue, not in the contract, so a re-read after a crashed
    // run sees the real count rather than the author's original zero.
    const prior = readState(issue.number)?.state;
    const attempts = prior?.attempts ?? task.attempts ?? 0;
    const withAttempts: Task = { ...task, attempts };

    const blockers = claimBlockers(withAttempts);
    if (blockers.length) {
      console.error(`dispatcher: #${issue.number} not claimable: ${blockers.join("; ")}`);
      continue;
    }

    const claimed: Task = {
      ...withAttempts,
      status: "claimed",
      claimed_at: new Date().toISOString(),
      claimed_by: runUrl(),
      source: { system: "github", number: issue.number, url: issue.url },
    };

    if (dryRun) {
      console.error(`dispatcher: would claim ${claimed.id} (#${issue.number})`);
      console.log(claimed.id);
      return;
    }

    // Claim durably BEFORE running, so a crash cannot cause a duplicate claim.
    try {
      relabel(issue.number, label, "factory:claimed");
    } catch (err) {
      console.error(`dispatcher: could not claim #${issue.number}: ${(err as Error).message}`);
      continue;
    }

    try {
      writeState(issue.number, {
        id: claimed.id,
        status: "claimed",
        attempts,
        claimed_at: claimed.claimed_at,
        claimed_by: claimed.claimed_by,
      });
    } catch (err) {
      // A claim the reconciler cannot see is worse than no claim at all: hand it back.
      console.error(`dispatcher: could not record state on #${issue.number}: ${(err as Error).message}`);
      try {
        relabel(issue.number, "factory:claimed", label);
      } catch {
        tryComment(
          issue.number,
          "Factory could not record run state here and could not restore the `factory:ready` " +
            "label. This issue needs a human to reset its labels before the factory retries."
        );
      }
      process.exit(1);
    }

    // The queue file is a cache for this run only — never the source of truth.
    mkdirSync(QUEUE_DIR, { recursive: true });
    mkdirSync(RUNS_DIR, { recursive: true });
    writeFileSync(join(QUEUE_DIR, `${claimed.id}.json`), JSON.stringify(claimed, null, 2) + "\n");

    if (process.env.GITHUB_ENV) {
      appendFileSync(process.env.GITHUB_ENV, `FACTORY_TASK_ID=${claimed.id}\n`);
      appendFileSync(process.env.GITHUB_ENV, `FACTORY_ISSUE=${issue.number}\n`);
    }
    console.error(`dispatcher: claimed ${claimed.id} (#${issue.number}) — ${claimed.title}`);
    console.log(claimed.id);
    return;
  }

  console.error("dispatcher: no claimable task (all candidates failed validation)");
  process.exit(NO_WORK);
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`dispatcher: ${(err as Error).message}`);
    process.exit(1);
  }
}

export { openFactoryPrCount, runUrl };
