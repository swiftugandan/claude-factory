#!/usr/bin/env -S npx -y tsx
/**
 * Durable run state, stored on the GitHub issue itself.
 *
 * The previous design split state across two stores: a durable label on the issue and
 * a JSON file under `.claude/factory/queue/`. In CI that directory is a fresh checkout
 * every tick, so the file evaporated while the label persisted. The reconciler read the
 * file, found nothing, and reported "queue is empty" forever — meaning a crashed run
 * left an issue labelled `factory:claimed` with no path back into the queue.
 *
 * The fix is not to persist the file harder. It is to stop having two sources of truth.
 * The issue is the queue: labels carry the coarse state, and a single marked comment
 * carries attempts, timestamps, cost, and the last error. Both survive a dead runner,
 * a cancelled workflow, and a fresh checkout, because neither lives in the workspace.
 *
 * CLI:
 *   npx tsx runner/state.ts read  --issue 42
 *   npx tsx runner/state.ts write --issue 42 --patch '{"status":"running","attempts":1}'
 */

import { gh, ghJson, repoSlug } from "./gh.ts";
import { argValue, isMain } from "./cli.ts";

export const STATE_MARKER = "<!-- claude-factory:state -->";

/**
 * Run state, which is deliberately not the same vocabulary as the contract's `status`.
 * The contract describes what a human intends; this describes what a runner observed.
 */
export type RunStatus =
  | "ready"
  | "claimed"
  | "running"
  | "failed"
  | "in_review"
  | "blocked"
  | "done";

export interface RunState {
  id: string;
  status: RunStatus;
  attempts: number;
  claimed_at?: string;
  claimed_by?: string;
  last_run_url?: string;
  cost_usd?: number;
  last_error?: string;
  updated_at?: string;
}

export function renderStateComment(state: RunState): string {
  return [
    STATE_MARKER,
    "**Factory run state** — maintained by the runner; edit the contract above, not this block.",
    "",
    "```json",
    JSON.stringify(state, null, 2),
    "```",
  ].join("\n");
}

export function parseStateComment(body: string): RunState | null {
  if (!body || !body.includes(STATE_MARKER)) return null;
  const fence = body.match(/```json\s*\n([\s\S]*?)```/);
  if (!fence) return null;
  try {
    const parsed = JSON.parse(fence[1]) as Partial<RunState>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string") return null;
    return {
      id: parsed.id,
      status: (parsed.status ?? "claimed") as RunStatus,
      attempts: typeof parsed.attempts === "number" ? parsed.attempts : 0,
      claimed_at: parsed.claimed_at,
      claimed_by: parsed.claimed_by,
      last_run_url: parsed.last_run_url,
      cost_usd: typeof parsed.cost_usd === "number" ? parsed.cost_usd : undefined,
      last_error: parsed.last_error,
      updated_at: parsed.updated_at,
    };
  } catch {
    return null;
  }
}

interface IssueComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredState {
  state: RunState;
  /** REST id of the comment holding the state, so it can be updated in place. */
  commentId: number | null;
  /** When the state comment last changed — the fallback age when claimed_at is absent. */
  updatedAt: string | null;
}

/** `gh` returns GraphQL node ids for comments; the REST id is on the end of the url. */
function restCommentId(comment: { url?: string; id?: string }): number | null {
  const fromUrl = comment.url?.match(/#issuecomment-(\d+)/)?.[1];
  if (fromUrl) return Number(fromUrl);
  if (comment.id && /^\d+$/.test(comment.id)) return Number(comment.id);
  return null;
}

export function readState(issue: number | string): StoredState | null {
  const data = ghJson<{ comments: Array<IssueComment & { url?: string }> }>([
    "issue",
    "view",
    String(issue),
    "--json",
    "comments",
  ]);

  // Last marked comment wins, so a manually pasted older block cannot shadow the runner's.
  for (let i = data.comments.length - 1; i >= 0; i--) {
    const comment = data.comments[i];
    const state = parseStateComment(comment.body);
    if (state) {
      return { state, commentId: restCommentId(comment), updatedAt: comment.updatedAt ?? null };
    }
  }
  return null;
}

export function writeState(issue: number | string, state: RunState): RunState {
  const stamped: RunState = { ...state, updated_at: new Date().toISOString() };
  const body = renderStateComment(stamped);
  const existing = readState(issue);

  if (existing?.commentId) {
    try {
      gh([
        "api",
        "-X",
        "PATCH",
        `/repos/${repoSlug()}/issues/comments/${existing.commentId}`,
        "-f",
        `body=${body}`,
      ]);
      return stamped;
    } catch (err) {
      console.error(`state: could not update comment, appending a new one: ${(err as Error).message}`);
    }
  }
  gh(["issue", "comment", String(issue), "--body", body]);
  return stamped;
}

/** Read-modify-write. Absent state is treated as a fresh, unclaimed record. */
export function patchState(
  issue: number | string,
  id: string,
  patch: Partial<RunState>
): RunState {
  const current = readState(issue)?.state ?? { id, status: "claimed" as RunStatus, attempts: 0 };
  return writeState(issue, { ...current, ...patch, id: current.id || id });
}

function main(): void {
  const [command] = process.argv.slice(2);
  const issue = argValue("issue");
  if (!issue || !command) {
    console.error("usage: state.ts <read|write> --issue <n> [--patch '<json>'] [--id <task>]");
    process.exit(64);
  }

  if (command === "read") {
    const stored = readState(issue);
    process.stdout.write(JSON.stringify(stored ?? { state: null }, null, 2) + "\n");
    return;
  }

  if (command === "write") {
    const raw = argValue("patch");
    if (!raw) {
      console.error("state.ts write: --patch '<json>' is required");
      process.exit(64);
    }
    const patch = JSON.parse(raw) as Partial<RunState>;
    const next = patchState(issue, argValue("id") ?? patch.id ?? "", patch);
    process.stdout.write(JSON.stringify(next, null, 2) + "\n");
    return;
  }

  console.error(`state.ts: unknown command '${command}'`);
  process.exit(64);
}

if (isMain(import.meta.url)) main();
