#!/usr/bin/env bash
# Append failed tool calls to the failure ledger.
#
# Registered on BOTH `PostToolUse` and `PostToolUseFailure`.
#
# `PostToolUseFailure` is where real failures arrive. `PostToolUse` fires only after a
# tool call *succeeds*, so a hook registered there alone never sees a failed Bash
# command, a blocked write, or a non-zero exit — no matter how good its detection is.
# An earlier revision dropped `PostToolUseFailure` on the belief that it was not a
# Claude Code hook event; it is one, and dropping it left the ledger permanently empty
# while looking correctly wired.
#
# The two events are disjoint — one fires on success, the other on failure — so being
# registered on both cannot double-count a single call. `hook_event_name` and
# `tool_use_id` are recorded on every entry so that assumption is checkable in the data
# rather than merely asserted here: duplicates would share a `tool_use_id`.
#
# `PostToolUse` is kept because some tools report an error in-band while the call itself
# succeeds, which is what the response-shape sniffing below is for.
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

# On `PostToolUseFailure` the event itself is the signal: the call failed, whatever
# shape the response happens to take. Sniffing it there would only reintroduce the
# possibility of discarding a real failure because its payload was unfamiliar.
#
# On `PostToolUse` the call succeeded, so a ledger entry requires the response to say
# otherwise. Unknown shapes are treated as success there: a ledger full of false
# positives is triaged the same way as one that is empty — by nobody.
failed="$(printf '%s' "$input" | jq -r '
  if (.hook_event_name // "") == "PostToolUseFailure" then true
  else
    (.tool_response // empty) as $r
    | if ($r | type) == "object" then
        (($r.is_error == true) or ($r.success == false) or (($r.error // "") != ""))
      elif ($r | type) == "string" then
        ($r | test("^\\s*(Error|Exception|Traceback)"; "i"))
      else false end
  end
' 2>/dev/null || echo "false")"

[ "$failed" = "true" ] || exit 0

printf '%s' "$input" | jq -c \
  --arg timestamp "$timestamp" \
  --arg status "tool_failure" \
  '{
    timestamp: $timestamp,
    session_id: (.session_id // "unknown"),
    status: $status,
    # Which event recorded this, and which call it was. Two entries sharing a
    # tool_use_id would mean the events are not disjoint after all — a claim worth
    # being able to check rather than assume.
    event: (.hook_event_name // "unknown"),
    tool_use_id: (.tool_use_id // null),
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
