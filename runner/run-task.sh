#!/usr/bin/env bash
# Run exactly one bounded factory task in an isolated worktree.
#
# Invariants this script enforces regardless of what the agent decides:
#   - the attempt is counted durably BEFORE the agent starts, so a crash still costs
#     a budget slot and cannot loop forever;
#   - a hard wall-clock timeout, enforced outside the agent;
#   - changed files must be inside allowed_paths, outside forbidden_paths, and must
#     never touch the harness;
#   - escalation artifacts are rescued out of the worktree before it is destroyed;
#   - the branch is pushed and a DRAFT pr is opened; nothing is ever merged;
#   - the worktree is removed on exit, including on failure.
set -euo pipefail

TASK_ID="${1:-${FACTORY_TASK_ID:-}}"
if [ -z "$TASK_ID" ]; then
  echo "usage: run-task.sh <TASK_ID>" >&2
  exit 64
fi

RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

TASK_FILE="${REPO_ROOT}/.claude/factory/queue/${TASK_ID}.json"
RUNS_DIR="${REPO_ROOT}/.claude/factory/runs"
BRANCH="factory/${TASK_ID}"
WORKTREE_ROOT="${FACTORY_WORKTREE_ROOT:-${REPO_ROOT}/../worktrees}"
WORKTREE="${WORKTREE_ROOT}/${TASK_ID}"
BASE_BRANCH="${FACTORY_BASE_BRANCH:-main}"

# --- Preflight. A guardrail that cannot evaluate must deny, not abstain. ---

for tool in jq git claude npx; do
  command -v "$tool" >/dev/null || { echo "run-task: '$tool' is required" >&2; exit 1; }
done
[ -f "$TASK_FILE" ] || { echo "run-task: no task contract at $TASK_FILE" >&2; exit 1; }

# Credentials. A headless run cannot open a browser to sign in, so an unauthenticated
# run would burn its worktree setup and fail at the first model call. Fail here instead.
#
# CLAUDE_CODE_OAUTH_TOKEN uses a Claude subscription — generate it with
# `claude setup-token` where you are already signed in. ANTHROPIC_API_KEY is the
# pay-per-token alternative. On a developer machine an interactive login already
# stored on disk is enough, so only require one of these in CI.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -n "${CI:-}" ]; then
  echo "run-task: no credential — set CLAUDE_CODE_OAUTH_TOKEN (from 'claude setup-token'," >&2
  echo "run-task: which uses your Claude subscription) or ANTHROPIC_API_KEY." >&2
  exit 78
fi

mkdir -p "$RUNS_DIR"

tsx_run() { npx -y tsx "$@"; }

MAX_MINUTES="$(jq -r '.budget.max_runtime_minutes // 30' "$TASK_FILE")"
MAX_ATTEMPTS="$(jq -r '.budget.max_attempts // 2' "$TASK_FILE")"
MAX_COST="$(jq -r '.budget.max_cost_usd // empty' "$TASK_FILE")"
TITLE="$(jq -r '.title' "$TASK_FILE")"
RISK="$(jq -r '.risk.level // "medium"' "$TASK_FILE")"
NEEDS_HUMAN_MERGE="$(jq -r '.risk.requires_human_merge // true' "$TASK_FILE")"
NEEDS_HUMAN_DEPLOY="$(jq -r '.risk.requires_human_deploy // true' "$TASK_FILE")"
TOUCHES_SCHEMA="$(jq -r '.risk.touches_schema // false' "$TASK_FILE")"
ISSUE="$(jq -r '.source.number // empty' "$TASK_FILE")"

RUN_URL="local"
if [ -n "${GITHUB_SERVER_URL:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
  RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
fi

# State lives on the issue, never in this workspace. Without an issue the run is
# untracked, which is acceptable locally but must be visible.
state_write() {
  [ -n "$ISSUE" ] || { echo "run-task: no source issue; state not recorded" >&2; return 0; }
  tsx_run "${RUNNER_DIR}/state.ts" write --issue "$ISSUE" --id "$TASK_ID" --patch "$1" >/dev/null \
    || echo "run-task: could not record run state on #${ISSUE}" >&2
}

PRIOR_ATTEMPTS=0
if [ -n "$ISSUE" ]; then
  PRIOR_ATTEMPTS="$(tsx_run "${RUNNER_DIR}/state.ts" read --issue "$ISSUE" 2>/dev/null \
    | jq -r '.state.attempts // 0' 2>/dev/null || echo 0)"
fi
ATTEMPT=$((PRIOR_ATTEMPTS + 1))

if [ "$ATTEMPT" -gt "$MAX_ATTEMPTS" ]; then
  echo "run-task: ${TASK_ID} exhausted its attempt budget (${MAX_ATTEMPTS})" >&2
  exit 75
fi

AUTONOMY_LEVEL="$(tsx_run "${RUNNER_DIR}/level.ts" 2>/dev/null || echo off)"
if [ "$ATTEMPT" -gt 1 ] && [ "$AUTONOMY_LEVEL" != "repair" ] && [ "$AUTONOMY_LEVEL" != "queue" ] \
   && [ "$AUTONOMY_LEVEL" != "automerge" ]; then
  echo "run-task: attempt ${ATTEMPT} is a repair, which requires autonomy.level >= repair" >&2
  echo "run-task: current level is '${AUTONOMY_LEVEL}'. Stopping." >&2
  exit 75
fi

# The agent runs unattended, so permission prompts would simply deny every tool and
# produce an empty branch. Bypassing prompts is only defensible because the boundary is
# enforced elsewhere: hooks at tool time, allowed_paths after the run, and CI on the PR.
# If the hooks are not installed, that argument does not hold and this refuses to run.
PERMISSION_MODE="${FACTORY_PERMISSION_MODE:-bypassPermissions}"
if [ "$PERMISSION_MODE" = "bypassPermissions" ]; then
  # The hooks may arrive either way: vendored into the project by /factory-bootstrap,
  # or supplied by the installed plugin against ${CLAUDE_PLUGIN_ROOT}. Accept both,
  # and require at least one — the whole justification for bypassing prompts is that
  # something is still enforcing the boundary at tool time.
  HOOKS_SOURCE=""
  if [ -d "${REPO_ROOT}/.claude/hooks" ] && [ -f "${REPO_ROOT}/.claude/settings.json" ]; then
    HOOKS_SOURCE="project (.claude/hooks)"
  elif claude plugin list 2>/dev/null | grep -q "claude-factory"; then
    HOOKS_SOURCE="plugin (claude-factory)"
  fi
  if [ -z "$HOOKS_SOURCE" ]; then
    echo "run-task: refusing to run with bypassPermissions — no guardrail hooks found." >&2
    echo "run-task: install the claude-factory plugin, or run /factory-bootstrap to" >&2
    echo "run-task: vendor .claude/hooks and .claude/settings.json into this project." >&2
    exit 78
  fi
  echo "run-task: guardrail hooks from ${HOOKS_SOURCE}"
fi

# A run without the factory skill is just an unsupervised agent with a prompt.
if claude plugin list >/dev/null 2>&1; then
  if ! claude plugin list 2>/dev/null | grep -q "claude-factory" \
     && [ ! -f "${REPO_ROOT}/.claude/skills/factory/SKILL.md" ]; then
    echo "run-task: the claude-factory plugin is not installed and no project-local" >&2
    echo "run-task: .claude/skills/factory/SKILL.md exists. Install it before running." >&2
    exit 78
  fi
else
  echo "run-task: could not verify plugin installation ('claude plugin list' unavailable)" >&2
fi

RUN_LOG="${RUNS_DIR}/${TASK_ID}-attempt-${ATTEMPT}.json"
ESCALATION="${RUNS_DIR}/${TASK_ID}-escalation.yaml"

# --- Cleanup rescues evidence before destroying the worktree. ---

cleanup() {
  local rc=$?
  cd "$REPO_ROOT" 2>/dev/null || true
  # The agent writes escalations and artifacts relative to its own checkout. Copy them
  # out first: a worktree removal that takes the escalation with it turns "ask a human"
  # into silence, which is the worst possible failure mode for an autonomous system.
  if [ -d "$WORKTREE" ]; then
    cp "${WORKTREE}/.claude/factory/runs/${TASK_ID}-escalation.yaml" "$ESCALATION" 2>/dev/null || true
    if [ -d "${WORKTREE}/artifacts" ]; then
      mkdir -p "${RUNS_DIR}/${TASK_ID}-artifacts"
      cp -R "${WORKTREE}/artifacts/." "${RUNS_DIR}/${TASK_ID}-artifacts/" 2>/dev/null || true
    fi
    git worktree remove --force "$WORKTREE" 2>/dev/null || true
  fi
  return $rc
}
trap cleanup EXIT

echo "run-task: ${TASK_ID} attempt ${ATTEMPT}/${MAX_ATTEMPTS} (risk=${RISK}, limit=${MAX_MINUTES}m, level=${AUTONOMY_LEVEL})"

# Count the attempt BEFORE running. A run that dies without writing state would
# otherwise be free, and a free attempt is an unbounded retry loop.
state_write "$(jq -nc --arg s running --argjson a "$ATTEMPT" --arg u "$RUN_URL" \
  '{status:$s, attempts:$a, last_run_url:$u}')"

# --- Isolated worktree. A repair continues the prior branch instead of discarding it. ---

git fetch origin "$BASE_BRANCH" --quiet
git worktree remove --force "$WORKTREE" 2>/dev/null || true

BASE_REF="origin/${BASE_BRANCH}"
if [ "$ATTEMPT" -gt 1 ] && git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git fetch origin "$BRANCH" --quiet
  BASE_REF="origin/${BRANCH}"
  echo "run-task: repairing on top of existing branch ${BRANCH}"
fi

git worktree add --force -B "$BRANCH" "$WORKTREE" "$BASE_REF" >/dev/null

# The contract travels with the worktree so the agent reads it from its own checkout.
mkdir -p "${WORKTREE}/.claude/factory/queue" "${WORKTREE}/.claude/factory/runs"
cp "$TASK_FILE" "${WORKTREE}/.claude/factory/queue/${TASK_ID}.json"

cd "$WORKTREE"

# --- Prompt. Skills are invoked by name; prose does not load a skill. ---

if [ "$ATTEMPT" -eq 1 ]; then
  SKILL_DIRECTIVE="/factory"
  ATTEMPT_NOTE="This is the first attempt."
else
  SKILL_DIRECTIVE="/factory-repair"
  ATTEMPT_NOTE="This is a repair attempt. The previous attempt failed; its transcript is
attached to the run at ${RUN_URL}. Make the smallest correction that addresses the
observed failure. Do not weaken any test."
fi

PROMPT="$(cat <<EOF
${SKILL_DIRECTIVE}

Task ID: ${TASK_ID}
Read the task contract at .claude/factory/queue/${TASK_ID}.json.
${ATTEMPT_NOTE}

Implement only this task. Stay strictly within its allowed_paths and outside its
forbidden_paths. Run the quality gates configured in .claude/factory/factory.yaml.
Use the factory-test-engineer and factory-reviewer subagents.
If all checks pass, commit with: factory(${TASK_ID}): <concise summary>.

Do not merge, deploy, alter permissions, modify hooks or CI configuration,
or make external writes. Do not push — the runner handles that.
If you cannot satisfy the acceptance criteria, stop and write a structured
escalation to .claude/factory/runs/${TASK_ID}-escalation.yaml.
EOF
)"

# --- Bounded execution. The timeout is external to the agent by design. ---

TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"

run_bounded() {
  local minutes="$1"; shift
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" --signal=TERM --kill-after=60s "${minutes}m" "$@"
    return $?
  fi
  # No coreutils `timeout` (common on macOS): supervise with a watchdog so the
  # wall-clock bound still holds rather than silently becoming unbounded.
  "$@" &
  local pid=$!
  ( sleep "$((minutes * 60))"; kill -TERM "$pid" 2>/dev/null || true
    sleep 60; kill -KILL "$pid" 2>/dev/null || true ) &
  local watchdog=$!
  local rc=0
  wait "$pid" || rc=$?
  kill -TERM "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  return $rc
}

set +e
run_bounded "$MAX_MINUTES" \
  claude -p "$PROMPT" --output-format json --permission-mode "$PERMISSION_MODE" > "$RUN_LOG"
CLAUDE_RC=$?
set -e

TIMED_OUT=false
case "$CLAUDE_RC" in
  0) ;;
  124|137|143)
    TIMED_OUT=true
    echo "run-task: ${TASK_ID} exceeded its ${MAX_MINUTES}m budget and was terminated" >&2 ;;
  *) echo "run-task: claude exited ${CLAUDE_RC}" >&2 ;;
esac

COST="$(jq -r '(.total_cost_usd // .cost_usd // empty)' "$RUN_LOG" 2>/dev/null || true)"
# A transcript that did not report a parseable cost must not corrupt the state record.
[[ "$COST" =~ ^[0-9]+([.][0-9]+)?$ ]] || COST=""
[ -n "$COST" ] && echo "run-task: run cost \$${COST}"

COST_EXCEEDED=false
if [ -n "$MAX_COST" ] && [ -n "$COST" ]; then
  if awk -v c="$COST" -v m="$MAX_COST" 'BEGIN { exit !(c > m) }'; then
    COST_EXCEEDED=true
    echo "run-task: cost \$${COST} exceeded the task budget of \$${MAX_COST}" >&2
  fi
fi

# --- Deterministic post-run checks. The agent's self-report is not evidence. ---

fail_run() {
  local message="$1"
  echo "run-task: ${message}" >&2
  state_write "$(jq -nc --arg s failed --argjson a "$ATTEMPT" --arg e "$message" \
    --arg u "$RUN_URL" --argjson c "${COST:-0}" \
    '{status:$s, attempts:$a, last_error:$e, last_run_url:$u, cost_usd:$c}')"
}

CHANGED="$(git diff --name-only "origin/${BASE_BRANCH}...HEAD" 2>/dev/null || true)"

if [ -f "${WORKTREE}/.claude/factory/runs/${TASK_ID}-escalation.yaml" ] && [ -z "$CHANGED" ]; then
  cp "${WORKTREE}/.claude/factory/runs/${TASK_ID}-escalation.yaml" "$ESCALATION"
  echo "run-task: ${TASK_ID} escalated to a human; no branch produced"
  if [ -n "$ISSUE" ] && command -v gh >/dev/null; then
    {
      echo "Factory task \`${TASK_ID}\` stopped and escalated on attempt ${ATTEMPT}/${MAX_ATTEMPTS}."
      echo
      echo '```yaml'
      cat "$ESCALATION"
      echo '```'
      echo
      echo "Run log: ${RUN_URL}"
    } | gh issue comment "$ISSUE" --body-file - || true
    gh issue edit "$ISSUE" --remove-label "factory:claimed" --add-label "factory:blocked" || true
  fi
  state_write "$(jq -nc --arg s blocked --argjson a "$ATTEMPT" --arg u "$RUN_URL" \
    '{status:$s, attempts:$a, last_run_url:$u}')"
  exit 0
fi

if [ -z "$CHANGED" ]; then
  if [ "$TIMED_OUT" = true ]; then
    fail_run "run hit the ${MAX_MINUTES}m timeout with no committed changes"
  else
    fail_run "no committed changes — nothing to open a PR for"
  fi
  exit 1
fi

if [ "$COST_EXCEEDED" = true ]; then
  fail_run "cost budget exceeded (\$${COST} > \$${MAX_COST})"
  echo "run-task: branch ${BRANCH} retained locally for inspection; no PR opened" >&2
  exit 76
fi

# allowed_paths, forbidden_paths, and the harness guard, in one tested implementation.
if ! printf '%s\n' "$CHANGED" | tsx_run "${RUNNER_DIR}/paths.ts" --task-file "$TASK_FILE" \
     > "${RUNS_DIR}/${TASK_ID}-paths.json"; then
  fail_run "changed files fall outside the task's scope"
  echo "run-task: branch ${BRANCH} retained locally for inspection; no PR opened" >&2
  exit 77
fi

# --- Push and open a draft PR. Nothing here merges, ever. ---

git push origin "HEAD:refs/heads/${BRANCH}"

if command -v gh >/dev/null; then
  BODY_FILE="$(mktemp)"
  {
    echo "Automated factory run for \`${TASK_ID}\` — **draft, not for auto-merge**."
    echo
    echo "- attempt: ${ATTEMPT}/${MAX_ATTEMPTS}"
    echo "- risk: ${RISK} (human merge required: ${NEEDS_HUMAN_MERGE}, human deploy required: ${NEEDS_HUMAN_DEPLOY})"
    [ "$TOUCHES_SCHEMA" = "true" ] && echo "- ⚠ touches schema — a forward-and-rollback plan is required below"
    [ -n "$COST" ] && echo "- run cost: \$${COST}${MAX_COST:+ of \$${MAX_COST} budgeted}"
    echo "- full transcript and artifacts: ${RUN_URL}"
    [ -n "$ISSUE" ] && echo "- source: #${ISSUE}"
    [ -f "$ESCALATION" ] && echo "- ⚠ the run also wrote an escalation; see the issue thread"
    echo
    echo "### Acceptance criteria"
    jq -r '.acceptance_criteria[] | "- [ ] " + .' "$TASK_FILE"
    echo
    echo "### Files changed"
    printf '%s\n' "$CHANGED" | sed 's/^/- /'
    echo
    echo "Verification output and rollback notes are in the PR description written by the"
    echo "agent, and the complete run transcript is attached to the workflow run above."
    echo "A human reviewer owns the merge decision."
  } > "$BODY_FILE"

  EXISTING_PR="$(gh pr list --head "$BRANCH" --state open --json number \
    --jq '.[0].number // empty' 2>/dev/null || true)"

  if [ -n "$EXISTING_PR" ]; then
    if gh pr comment "$EXISTING_PR" --body-file "$BODY_FILE"; then
      PR_STATE="updated PR #${EXISTING_PR}"
    else
      echo "run-task: could not comment on PR #${EXISTING_PR}" >&2
    fi
  else
    if gh pr create --draft \
      --title "factory(${TASK_ID}): ${TITLE}" \
      --body-file "$BODY_FILE" \
      --base "$BASE_BRANCH" \
      --head "$BRANCH"; then
      PR_STATE="draft PR opened"
    else
      echo "run-task: pr create failed; branch is pushed" >&2
    fi
  fi
  rm -f "$BODY_FILE"

  if [ -n "$ISSUE" ]; then
    gh issue edit "$ISSUE" --remove-label "factory:claimed" --add-label "factory:needs-review" \
      || echo "run-task: could not relabel #${ISSUE}" >&2
  fi
fi

state_write "$(jq -nc --arg s in_review --argjson a "$ATTEMPT" --arg u "$RUN_URL" \
  --argjson c "${COST:-0}" '{status:$s, attempts:$a, last_run_url:$u, cost_usd:$c}')"

# Report what actually happened. Claiming a PR was opened when `gh pr create` failed
# is the same class of error the harness exists to prevent in the agent — a success
# line that outruns the evidence. The branch is pushed either way; say which it was.
echo "run-task: ${TASK_ID} complete — ${PR_STATE:-branch pushed, NO PR} on ${BRANCH}"
