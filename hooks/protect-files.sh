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
file_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
file_path="${file_path//\\//}"

protected_patterns=(
  ".env"
  ".env."
  ".git/"
  "id_rsa"
  "credentials"
)

for pattern in "${protected_patterns[@]}"; do
  if [[ "$file_path" == *"$pattern"* ]]; then
    echo "Blocked: protected path '$file_path' matches '$pattern'." >&2
    exit 2
  fi
done

exit 0
