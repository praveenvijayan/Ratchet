#!/usr/bin/env bash
# Update the Ratchet FRAMEWORK files in this repo from upstream.
# Pulls ONLY framework paths and never touches project-owned files:
#   memory/, plan/*.md issues, GATES.md, .env, .env.example, README.md, LICENSE, .gitignore, your code.
#
# Usage:
#   ./scripts/ratchet-update.sh            # update from upstream main
#   ./scripts/ratchet-update.sh v1.2.0     # update to a specific tag
# Env:
#   RATCHET_REMOTE=<git url>               # override upstream (default below)
set -euo pipefail

REMOTE_URL="${RATCHET_REMOTE:-https://github.com/praveenvijayan/Ratchet.git}"
REF="${1:-main}"

# Framework-owned paths — safe to overwrite from upstream.
# The whole `scripts/` directory ships so that every script a shipped workflow
# invokes (and every helper those scripts import) always lands in the consumer
# repo — the list can't drift behind the workflows. `scripts/ratchet-update.test.mjs`
# guards this. Deliberately EXCLUDES: GATES.md, memory/, plan/*.md (issues),
# .env, .env.example, README.md, LICENSE, .gitignore — those are project-owned.
FRAMEWORK_PATHS=(
  .agents .claude plugin .claude-plugin
  .github/workflows
  scripts
  setup.sh
  plan/README.md
  AGENTS.md CLAUDE.md GEMINI.md DOCS.md
)

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not inside a git repo."; exit 1; }

if git remote | grep -qx ratchet; then
  git remote set-url ratchet "$REMOTE_URL"
else
  git remote add ratchet "$REMOTE_URL"
fi

echo "Fetching '$REF' from $REMOTE_URL ..."
git fetch --quiet ratchet "$REF" --tags 2>/dev/null || true

SRC="ratchet/$REF"
git rev-parse --verify --quiet "${SRC}^{commit}" >/dev/null || SRC="$REF"   # tag case
git rev-parse --verify --quiet "${SRC}^{commit}" >/dev/null || { echo "Cannot resolve ref '$REF' upstream."; exit 1; }

normalize_version() {
  local raw="$1"
  if [[ "$raw" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    printf '%s.%s.%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
  else
    printf '%s\n' "$raw"
  fi
}

echo "Updating framework files from $SRC ..."
git checkout "$SRC" -- "${FRAMEWORK_PATHS[@]}"

if [ -x ./setup.sh ]; then ./setup.sh >/dev/null 2>&1 && echo "Skill mirrors re-synced."; fi

# Record the new version (prefer upstream's .ratchet-version if present)
NEWVER="$(normalize_version "$REF")"
if git cat-file -e "${SRC}:.ratchet-version" 2>/dev/null; then
  NEWVER="$(normalize_version "$(git show "${SRC}:.ratchet-version" | head -n1 | tr -d '[:space:]')")"
fi
printf '%s\n' "$NEWVER" > .ratchet-version

echo
echo "Ratchet framework updated to: $NEWVER"
echo "Untouched (project-owned): GATES.md, memory/, plan/ issues, .env, .env.example, README.md, LICENSE, .gitignore, your code."
echo "Next: review 'git diff', and if your stack changed, re-run /ratchet-init to refresh GATES.md."
