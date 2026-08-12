#!/usr/bin/env bash
# Append failed tool calls to the failure ledger.
#
# This runs on PostToolUse and decides for itself whether the call failed. It used to
# be registered on `PostToolUseFailure`, which is not a Claude Code hook event — the
# entry was silently ignored, the ledger stayed empty, and `/factory-evolve` had no
# evidence to evolve from. The learning loop is only as good as its input, so the entry
# now records what failed, not merely that something did.
#
# Observational, not a guardrail: this never blocks a tool call.
set -uo pipefail

input="$(cat)"
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
ledger="$root/.claude/factory/failures.jsonl"
timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

mkdir -p "$(dirname "$ledger")" 2>/dev/null || exit 0

# If jq is missing, record a degraded entry rather than failing the run.
# Losing evidence is bad; blocking a session over it is worse.
if ! command -v jq >/dev/null 2>&1; then
  printf '{"timestamp":"%s","status":"tool_failure","tool":"unknown","triaged":false,"resolution":null,"note":"jq unavailable; entry degraded"}\n' \
    "$timestamp" >> "$ledger"
  exit 0
fi

# A tool call counts as failed when the response says so in any of the shapes the
# harness emits. Unknown shapes are treated as success: a ledger full of false
# positives is triaged the same way as one that is empty — by nobody.
failed="$(printf '%s' "$input" | jq -r '
  (.tool_response // empty) as $r
  | if ($r | type) == "object" then
      (($r.is_error == true) or ($r.success == false) or (($r.error // "") != ""))
    elif ($r | type) == "string" then
      ($r | test("^\\s*(Error|Exception|Traceback)"; "i"))
    else false end
' 2>/dev/null || echo "false")"

[ "$failed" = "true" ] || exit 0

printf '%s' "$input" | jq -c \
  --arg timestamp "$timestamp" \
  --arg status "tool_failure" \
  '{
    timestamp: $timestamp,
    session_id: (.session_id // "unknown"),
    status: $status,
    tool: (.tool_name // "unknown"),
    cwd: (.cwd // null),
    # The specific invocation, so a reader can reproduce it without the transcript.
    target: (
      .tool_input.command
      // .tool_input.file_path
      // .tool_input.pattern
      // null
    ),
    error: (
      (if (.tool_response | type) == "object"
         then (.tool_response.error // .tool_response.stderr // (.tool_response | tostring))
         else (.tool_response | tostring) end)
      | tostring | .[0:2000]
    ),
    triaged: false,
    resolution: null
  }' >> "$ledger" 2>/dev/null || true

exit 0
