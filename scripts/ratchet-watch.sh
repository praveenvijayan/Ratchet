#!/usr/bin/env bash
# ratchet-watch.sh — real-time GitHub → local bridge for Ratchet.
# No CI, no public server, no extra API key: uses `gh webhook forward` over your
# existing gh login. Surfaces PR merges/reviews so the agent can advance or rework.
#
# Usage:
#   ./scripts/ratchet-watch.sh                 # watch the current repo, notify only
#   ./scripts/ratchet-watch.sh owner/repo      # watch a specific repo
#
# Auto-run the agent on each event (optional) — uses your local, already-logged-in
# CLI, no API key:
#   RATCHET_ON_EVENT="claude -p 'Run /ratchet-next per AGENTS.md'" ./scripts/ratchet-watch.sh
#   RATCHET_ON_EVENT="codex exec 'Run /ratchet-next per AGENTS.md'" ./scripts/ratchet-watch.sh
set -euo pipefail

PORT="${RATCHET_PORT:-8765}"
REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
EVENTS="pull_request,pull_request_review,pull_request_review_comment"

command -v gh   >/dev/null || { echo "gh CLI required (https://cli.github.com)"; exit 1; }
command -v node >/dev/null || { echo "Node 20+ required"; exit 1; }
gh extension list 2>/dev/null | grep -q "cli/gh-webhook" || gh extension install cli/gh-webhook

HERE="$(cd "$(dirname "$0")" && pwd)"
RATCHET_PORT="$PORT" RATCHET_ON_EVENT="${RATCHET_ON_EVENT:-}" node "$HERE/ratchet-watch.mjs" "$PORT" &
RECV=$!
trap 'kill "$RECV" 2>/dev/null || true' EXIT INT TERM
sleep 1

echo "[ratchet] watching $REPO — forwarding [$EVENTS] to http://localhost:$PORT/webhook"
echo "[ratchet] leave this running; on a merge or review it will signal /ratchet-next."
gh webhook forward --repo="$REPO" --events="$EVENTS" --url="http://localhost:$PORT/webhook"
