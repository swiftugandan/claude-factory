#!/usr/bin/env bash
# Block the running agent from editing its own guardrails.
#
# A factory may propose changes to its hooks, CI, merge policy, or runner --
# through a separately reviewed pull request written by a human. It may not
# make those changes during an autonomous run, because a system that can rewrite
# its own constraints mid-task has no constraints.
set -euo pipefail

# Fail CLOSED. Claude Code treats only exit code 2 as blocking; any other non-zero
# exit is a non-blocking error, so a missing dependency would silently let the edit
# through. A guardrail that cannot evaluate must deny, not abstain.
if ! command -v jq >/dev/null 2>&1; then
  echo "Blocked: jq is required to evaluate this guardrail and is not installed." >&2
  exit 2
fi

input="$(cat)"
file_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
[ -z "$file_path" ] && exit 0

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
rel="${file_path#"$root"/}"
rel="${rel//\\//}"

# Kept identical to HOOK_GUARDED_PREFIXES in runner/paths.ts.
# runner/paths.test.ts fails if the two lists drift: three layers enforce this
# boundary, and a system whose layers disagree reads as defended while one of them
# quietly allows what the others block.
guarded_prefixes=(
  ".github/workflows/"
  ".claude/hooks/"
  ".claude/settings.json"
  ".claude/settings.local.json"
  "runner/"
  "CODEOWNERS"
  ".github/CODEOWNERS"
)

for prefix in "${guarded_prefixes[@]}"; do
  # A trailing slash means "this directory"; anything else must match exactly, so
  # `CODEOWNERS.md` and `.claude/settings.json.bak` are not over-blocked.
  if [[ "$prefix" == */ && "$rel" == "$prefix"* ]] || [[ "$prefix" != */ && "$rel" == "$prefix" ]]; then
    echo "Blocked: '$rel' is part of the factory harness." >&2
    echo "Hooks, CI, runner, and ownership rules require a separately reviewed PR." >&2
    exit 2
  fi
done

# factory.yaml is readable and mostly editable, but its safety gates are not.
if [[ "$rel" == ".claude/factory/factory.yaml" ]]; then
  new_content="$(printf '%s' "$input" | jq -r '.tool_input.new_string // .tool_input.content // empty')"
  if printf '%s' "$new_content" | grep -Eq 'require_(human_approval_for_production_deploy|review_for_production_code|tests_for_behavior_change|typecheck|rollback_plan_for_schema_change)\s*:\s*false'; then
    echo "Blocked: this edit disables a quality gate in factory.yaml." >&2
    echo "Lowering a gate is a human decision, not a way to make a task pass." >&2
    exit 2
  fi
fi

exit 0
