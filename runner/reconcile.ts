#!/usr/bin/env -S npx -y tsx
/**
 * Reconcile: bring the queue back to a truthful state.
 *
 * Autonomous systems fail by leaving things half-claimed. A run dies mid-flight, the
 * issue stays labelled `factory:claimed`, and the task is invisible forever. This
 * process is the antidote: it is the only component allowed to move a task backwards.
 *
 * It reads GitHub, not the workspace. The earlier version listed a local queue
 * directory that CI recreates empty on every checkout, so it always reported an empty
 * queue and never recovered anything — the exact failure it exists to prevent.
 *
 * It does NOT retry work itself. It restores tasks to `ready` (so the dispatcher may
 * pick them up within budget) or escalates them to a human. Retrying is the runner's
 * job, bounded by max_attempts; reconcile never raises a budget.
 *
 * Usage:
 *   npx tsx runner/reconcile.ts
 *   npx tsx runner/reconcile.ts --stale-minutes 90 --dry-run
 */

import { execFileSync } from "node:child_process";

import { ghJson, relabel, tryComment } from "./gh.ts";
import { argValue, hasFlag, isMain } from "./cli.ts";
import { parseTaskContract } from "./contract.ts";
import { loadConfig } from "./config.ts";
import { readState, writeState, type RunStatus } from "./state.ts";

export type Action = "skip" | "review" | "block" | "release";

export interface Decision {
  action: Action;
  reason: string;
}

export interface DecisionInput {
  status: RunStatus;
  attempts: number;
  maxAttempts: number;
  /** Minutes since the claim was recorded. */
  ageMinutes: number;
  /** How long a claim may legitimately stay open: runtime budget plus slack. */
  graceMinutes: number;
  branchHasWork: boolean;
}

/**
 * The whole reconciliation policy, as one pure function.
 *
 * Kept free of I/O on purpose: this is the logic that decides whether a human gets
 * paged or a task quietly disappears, and it needs to be testable without a network.
 */
export function decide(input: DecisionInput): Decision {
  const { status, attempts, maxAttempts, ageMinutes, graceMinutes, branchHasWork } = input;

  if (status === "in_review" || status === "blocked" || status === "done") {
    return { action: "skip", reason: `already ${status}` };
  }

  // A run that reported failure needs no grace period — we know it ended.
  const ended = status === "failed";
  if (!ended && ageMinutes < graceMinutes) {
    return {
      action: "skip",
      reason: `claimed ${Math.round(ageMinutes)}m ago, within the ${Math.round(graceMinutes)}m grace window`,
    };
  }

  // A pushed branch means the run produced evidence — a human should look, not a retry.
  if (branchHasWork) {
    return { action: "review", reason: "branch holds committed work" };
  }
  if (attempts >= maxAttempts) {
    return { action: "block", reason: `attempt budget exhausted (${attempts}/${maxAttempts})` };
  }
  return {
    action: "release",
    reason: ended
      ? `run failed with no branch (attempt ${attempts}/${maxAttempts})`
      : `stale claim after ${Math.round(ageMinutes)}m (attempt ${attempts}/${maxAttempts})`,
  };
}

function branchHasWork(taskId: string): boolean {
  try {
    const out = execFileSync("git", ["ls-remote", "--heads", "origin", `factory/${taskId}`], {
      encoding: "utf8",
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

interface ClaimedIssue {
  number: number;
  title: string;
  body: string;
  updatedAt: string;
}

function main(): void {
  const config = loadConfig();
  const dryRun = hasFlag("dry-run");
  const staleMinutes = Number(argValue("stale-minutes") ?? 90);
  const readyLabel = config.autonomy.ready_label;

  const issues = ghJson<ClaimedIssue[]>([
    "issue", "list", "--label", "factory:claimed", "--state", "open",
    "--limit", "100", "--json", "number,title,body,updatedAt",
  ]);

  if (!issues.length) {
    console.log("reconcile: no claimed tasks");
    return;
  }

  let released = 0, blocked = 0, reviewed = 0, skipped = 0;

  for (const issue of issues) {
    const { task } = parseTaskContract(issue.body ?? "");
    const stored = readState(issue.number);
    const state = stored?.state;

    if (!task) {
      // Claimed but no longer parseable: the body was edited mid-flight. Do not guess.
      console.log(`reconcile: #${issue.number} → blocked (contract no longer parses)`);
      if (!dryRun) {
        try {
          relabel(issue.number, "factory:claimed", "factory:blocked");
        } catch (err) {
          console.error(`reconcile: could not relabel #${issue.number}: ${(err as Error).message}`);
        }
        tryComment(
          issue.number,
          "Factory released this claim: the task contract in the body no longer parses. " +
            "Fix the contract and re-apply `" + readyLabel + "` when it is ready again."
        );
      }
      blocked++;
      continue;
    }

    const id = task.id;
    const attempts = state?.attempts ?? 0;
    const maxAttempts = task.budget.max_attempts;

    // claimed_at is authoritative; the state comment's own timestamp is the fallback,
    // and the issue's updatedAt is the last resort. An unknown age is never "infinitely
    // stale" — that would yank a task away from a run that started thirty seconds ago.
    const anchor = state?.claimed_at ?? stored?.updatedAt ?? issue.updatedAt;
    const parsedAnchor = Date.parse(anchor ?? "");
    const ageMinutes = Number.isNaN(parsedAnchor) ? 0 : (Date.now() - parsedAnchor) / 60000;

    const decision = decide({
      status: state?.status ?? "claimed",
      attempts,
      maxAttempts,
      ageMinutes,
      graceMinutes: task.budget.max_runtime_minutes + staleMinutes,
      branchHasWork: branchHasWork(id),
    });

    if (decision.action === "skip") {
      console.log(`reconcile: ${id} — no action (${decision.reason})`);
      skipped++;
      continue;
    }

    console.log(`reconcile: ${id} → ${decision.action} (${decision.reason})`);
    if (dryRun) continue;

    try {
      if (decision.action === "review") {
        writeState(issue.number, { ...(state ?? { id, attempts }), id, status: "in_review", attempts });
        relabel(issue.number, "factory:claimed", "factory:needs-review");
        tryComment(
          issue.number,
          `Factory run for \`${id}\` stopped with work on branch \`factory/${id}\`. ` +
            `Moved to review rather than retried — a human should inspect the branch before it runs again.`
        );
        reviewed++;
      } else if (decision.action === "block") {
        writeState(issue.number, { ...(state ?? { id, attempts }), id, status: "blocked", attempts });
        relabel(issue.number, "factory:claimed", "factory:blocked");
        tryComment(
          issue.number,
          `Factory task \`${id}\` is blocked after ${attempts}/${maxAttempts} attempts ` +
            `with no branch produced. This needs a human decision — most often a missing ` +
            `credential, an unclear acceptance criterion, or a dependency outside allowed_paths. ` +
            `Raising the attempt budget without diagnosing the cause will just burn it again.` +
            (state?.last_error ? `\n\nLast error: \`${state.last_error}\`` : "")
        );
        blocked++;
      } else {
        writeState(issue.number, {
          id,
          status: "ready",
          attempts,
          last_error: state?.last_error,
          cost_usd: state?.cost_usd,
        });
        relabel(issue.number, "factory:claimed", readyLabel);
        released++;
      }
    } catch (err) {
      console.error(`reconcile: could not apply ${decision.action} to #${issue.number}: ${(err as Error).message}`);
    }
  }

  console.log(
    `reconcile: ${released} released, ${blocked} blocked, ${reviewed} sent to review, ${skipped} untouched` +
      (dryRun ? " (dry run — nothing written)" : "")
  );
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`reconcile: ${(err as Error).message}`);
    process.exit(1);
  }
}
