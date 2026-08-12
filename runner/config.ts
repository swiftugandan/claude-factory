/**
 * Read `.claude/factory/factory.yaml` and turn it into decisions.
 *
 * `autonomy.level` was previously documentation: the rollout ladder existed in prose
 * and no code consulted it, so every level behaved identically. The ladder is the
 * operator's main control surface — it has to be enforced or removed. It is enforced
 * here, and the fail-closed default is `off`: a missing or unreadable manifest means
 * no autonomous run, not an unconfigured one.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseYaml, YamlError, type YamlValue } from "./yaml.ts";

export const CONFIG_PATH = ".claude/factory/factory.yaml";

/** Ordered from least to most authority. Each level is a superset of the previous. */
export const AUTONOMY_LEVELS = ["off", "pr_only", "repair", "queue", "automerge"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export interface FactoryConfig {
  commands: Record<string, string>;
  quality_gates: Record<string, boolean>;
  autonomy: {
    level: AutonomyLevel;
    base_branch: string;
    ready_label: string;
    concurrency: number;
    auto_merge_allowed_classes: string[];
    never_autonomous: string[];
    budgets: {
      default_max_runtime_minutes: number;
      default_max_attempts: number;
      max_open_factory_prs: number;
    };
  };
}

export const DEFAULT_CONFIG: FactoryConfig = {
  commands: {},
  quality_gates: {},
  autonomy: {
    level: "off",
    base_branch: "main",
    ready_label: "factory:ready",
    concurrency: 1,
    auto_merge_allowed_classes: [],
    never_autonomous: [],
    budgets: {
      default_max_runtime_minutes: 30,
      default_max_attempts: 2,
      max_open_factory_prs: 5,
    },
  },
};

const asRecord = (v: YamlValue): Record<string, YamlValue> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, YamlValue>) : {};

const asStringList = (v: YamlValue): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const asNumber = (v: YamlValue, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const asString = (v: YamlValue, fallback: string): string =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : fallback;

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return AUTONOMY_LEVELS.includes(value as AutonomyLevel);
}

/** Build a config from an already-parsed document. Pure, so it is directly testable. */
export function configFromDocument(doc: YamlValue): FactoryConfig {
  const root = asRecord(doc);
  const autonomy = asRecord(root.autonomy);
  const budgets = asRecord(autonomy.budgets);
  const d = DEFAULT_CONFIG.autonomy;

  const rawLevel = autonomy.level;
  if (rawLevel !== undefined && rawLevel !== null && !isAutonomyLevel(rawLevel)) {
    throw new Error(
      `factory.yaml: autonomy.level '${String(rawLevel)}' is not one of ${AUTONOMY_LEVELS.join(", ")}`
    );
  }

  const commands: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(root.commands))) {
    // `TODO` is not a command. A gate that is not wired up must read as absent, so it
    // fails loudly at the point of use rather than appearing to have run.
    if (typeof value === "string" && value.trim() !== "" && value.trim() !== "TODO") {
      commands[key] = value.trim();
    }
  }

  const quality_gates: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(asRecord(root.quality_gates))) {
    if (typeof value === "boolean") quality_gates[key] = value;
  }

  return {
    commands,
    quality_gates,
    autonomy: {
      level: isAutonomyLevel(rawLevel) ? rawLevel : d.level,
      base_branch: asString(autonomy.base_branch, d.base_branch),
      ready_label: asString(autonomy.ready_label, d.ready_label),
      concurrency: asNumber(autonomy.concurrency, d.concurrency),
      auto_merge_allowed_classes: asStringList(autonomy.auto_merge_allowed_classes),
      never_autonomous: asStringList(autonomy.never_autonomous),
      budgets: {
        default_max_runtime_minutes: asNumber(
          budgets.default_max_runtime_minutes,
          d.budgets.default_max_runtime_minutes
        ),
        default_max_attempts: asNumber(budgets.default_max_attempts, d.budgets.default_max_attempts),
        max_open_factory_prs: asNumber(budgets.max_open_factory_prs, d.budgets.max_open_factory_prs),
      },
    },
  };
}

export function loadConfig(path = CONFIG_PATH): FactoryConfig {
  if (!existsSync(path)) {
    console.error(`config: ${path} not found — autonomy stays 'off' until it exists`);
    return DEFAULT_CONFIG;
  }
  try {
    return configFromDocument(parseYaml(readFileSync(path, "utf8")));
  } catch (err) {
    if (err instanceof YamlError) {
      // Fail closed: an unreadable manifest is not permission to proceed.
      throw new Error(`config: ${path} is not valid YAML — ${err.message}`);
    }
    throw err;
  }
}

export function atLeast(level: AutonomyLevel, required: AutonomyLevel): boolean {
  return AUTONOMY_LEVELS.indexOf(level) >= AUTONOMY_LEVELS.indexOf(required);
}

/** Scheduled, label-driven claiming is the `queue` level. */
export const canClaimFromQueue = (level: AutonomyLevel) => atLeast(level, "queue");

/** A human naming one specific task is the `pr_only` level. */
export const canClaimExplicit = (level: AutonomyLevel) => atLeast(level, "pr_only");

/** A second, bounded attempt against concrete failure output is the `repair` level. */
export const canRepair = (level: AutonomyLevel) => atLeast(level, "repair");
