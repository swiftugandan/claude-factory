#!/usr/bin/env bash
set -euo pipefail

# Fail CLOSED. Claude Code treats only exit code 2 as blocking; any other non-zero
# exit is a non-blocking error, so a missing dependency would silently let the edit
# through. A guardrail that cannot evaluate must deny, not abstain.
if ! command -v jq >/dev/null 2>&1; then
  echo "Blocked: jq is required to evaluate this guardrail and is not installed." >&2
  exit 2
fi

input="$(cat)"
command="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"

blocked_patterns=(
  "rm -rf /"
  "git push --force"
  "git reset --hard"
  "DROP DATABASE"
  "DROP TABLE"
  "kubectl delete namespace"
  "terraform destroy"
)

for pattern in "${blocked_patterns[@]}"; do
  if [[ "$command" == *"$pattern"* ]]; then
    echo "Blocked dangerous command pattern: $pattern" >&2
    exit 2
  fi
done

exit 0
