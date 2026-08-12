#!/usr/bin/env bash
# Stop hook: report an uncommitted worktree at the end of a session.
# Advisory only -- never blocks, never commits anything on the user's behalf.
set -euo pipefail

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$root" 2>/dev/null || exit 0

command -v git >/dev/null 2>&1 || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

status="$(git status --porcelain 2>/dev/null || true)"
[ -z "$status" ] && exit 0

count="$(printf '%s\n' "$status" | grep -c . || true)"
echo "Worktree has $count uncommitted change(s):" >&2
printf '%s\n' "$status" | head -n 20 >&2
[ "$count" -gt 20 ] && echo "  ... and $((count - 20)) more" >&2

exit 0
