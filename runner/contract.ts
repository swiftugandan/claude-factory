/**
 * The task contract: parsing it out of an issue body and validating it against
 * `runner/task-schema.json`.
 *
 * A task is claimable only if it is fully specified. Reject, do not repair — an
 * under-specified task produces an under-specified PR, and the cost of that lands
 * on a human reviewer who did not choose it.
 */

import { readFileSync } from "node:fs";
import {
  fencedYamlBlocks,
  hasUnterminatedYamlFence,
  parseYaml,
  YamlError,
  type YamlValue,
} from "./yaml.ts";
import { validate, type Schema } from "./schema.ts";

export type TaskStatus = "draft" | "ready" | "claimed" | "in_review" | "blocked" | "done";

export interface Risk {
  level: "low" | "medium" | "high";
  requires_human_merge?: boolean;
  requires_human_deploy?: boolean;
  touches_schema?: boolean;
  touches_external_writes?: boolean;
}

export interface Budget {
  max_runtime_minutes: number;
  max_attempts: number;
  max_cost_usd?: number;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  owner: string;
  source?: { system: string; url?: string; number?: number | string };
  acceptance_criteria: string[];
  allowed_paths: string[];
  forbidden_paths?: string[];
  context?: string[];
  risk: Risk;
  budget: Budget;
  attempts?: number;
  claimed_at?: string;
  claimed_by?: string;
}

let cachedSchema: Schema | null = null;

export function taskSchema(): Schema {
  if (!cachedSchema) {
    const path = new URL("./task-schema.json", import.meta.url);
    cachedSchema = JSON.parse(readFileSync(path, "utf8")) as Schema;
  }
  return cachedSchema;
}

export interface ParseResult {
  /** The validated task, or null when nothing in the body satisfied the contract. */
  task: Task | null;
  /** Human-readable reasons the body was not claimable. */
  problems: string[];
  /** Index of the fenced block that was treated as the contract, for error messages. */
  blockIndex: number | null;
}

/** A candidate block is one that at least tries to be a task contract. */
function looksLikeContract(value: YamlValue): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "id" in value &&
    "status" in value
  );
}

/**
 * Parse the task contract from a markdown body.
 *
 * Every fenced yaml block is considered, not just the first: issue templates and
 * humans routinely paste an example above the real contract, and silently claiming
 * the example is a worse failure than not claiming at all.
 */
export function parseTaskContract(body: string): ParseResult {
  const blocks = fencedYamlBlocks(body ?? "");

  // Report this alongside whatever else we find. An unterminated block is invisible
  // to the extractor, so without this the reported problems describe a different
  // block entirely and the author edits the wrong text.
  const unterminated = hasUnterminatedYamlFence(body ?? "")
    ? ["an unterminated ```yaml block was ignored — check its closing fence"]
    : [];

  if (!blocks.length) {
    return {
      task: null,
      problems: [...unterminated, "no fenced ```yaml task contract in the body"],
      blockIndex: null,
    };
  }

  const candidates: Array<{ index: number; value: YamlValue }> = [];
  const parseErrors: string[] = [];

  blocks.forEach((block, index) => {
    let value: YamlValue;
    try {
      value = parseYaml(block);
    } catch (err) {
      if (err instanceof YamlError) parseErrors.push(`block ${index + 1}: ${err.message}`);
      else throw err;
      return;
    }
    if (looksLikeContract(value)) candidates.push({ index, value });
  });

  if (!candidates.length) {
    return {
      task: null,
      problems: [
        ...unterminated,
        ...(parseErrors.length
          ? parseErrors
          : ["no fenced yaml block contained a task contract (needs at least 'id' and 'status')"]),
      ],
      blockIndex: null,
    };
  }

  const schema = taskSchema();
  let firstFailure: ParseResult | null = null;

  for (const candidate of candidates) {
    const problems = validate(candidate.value, schema);
    if (!problems.length) {
      return { task: candidate.value as unknown as Task, problems: [], blockIndex: candidate.index };
    }
    firstFailure ??= {
      task: null,
      problems: [...unterminated, ...problems.map((p) => `block ${candidate.index + 1} ${p}`)],
      blockIndex: candidate.index,
    };
  }
  return firstFailure!;
}

/** Reasons a syntactically valid contract still may not be claimed right now. */
export function claimBlockers(task: Task): string[] {
  const problems: string[] = [];
  if (task.status !== "ready") {
    problems.push(`status is '${task.status}', expected 'ready'`);
  }
  const attempts = task.attempts ?? 0;
  if (attempts >= task.budget.max_attempts) {
    problems.push(`attempt budget exhausted (${attempts}/${task.budget.max_attempts})`);
  }
  return problems;
}
