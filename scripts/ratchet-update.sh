#!/usr/bin/env bash
# Update the Ratchet FRAMEWORK files in this repo from upstream. Manifest- and
# profile-aware: reads ratchet-manifest.json at the target ref and pulls only
# the `framework` files for the profile(s) recorded in this project's
# .ratchet-install.json (written by scripts/bootstrap.sh) — never the whole
# tree, and never `generated`/project-owned paths (they are never selected).
#
# Usage:
#   ./scripts/ratchet-update.sh            # update from upstream main
#   ./scripts/ratchet-update.sh v1.2.0     # update to a specific tag
# Env:
#   RATCHET_REMOTE=<git url>               # override upstream (default below)
set -euo pipefail

REMOTE_URL="${RATCHET_REMOTE:-https://github.com/praveenvijayan/Ratchet.git}"
REF="${1:-main}"
INSTALL_FILE=".ratchet-install.json"
die() { echo "ratchet-update: $*" >&2; exit 1; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repo."
[ -f "$INSTALL_FILE" ] || die "no $INSTALL_FILE found in this project — run scripts/bootstrap.sh first."

if git remote | grep -qx ratchet; then
  git remote set-url ratchet "$REMOTE_URL"
else
  git remote add ratchet "$REMOTE_URL"
fi

echo "Fetching '$REF' from $REMOTE_URL ..."
git fetch --quiet ratchet "$REF" --tags 2>/dev/null || true

SRC="ratchet/$REF"
git rev-parse --verify --quiet "${SRC}^{commit}" >/dev/null || SRC="$REF"   # tag case
git rev-parse --verify --quiet "${SRC}^{commit}" >/dev/null || die "cannot resolve ref '$REF' upstream."
git cat-file -e "${SRC}:ratchet-manifest.json" 2>/dev/null || die "ref '$REF' has no ratchet-manifest.json — cannot select files."

normalize_version() {
  local raw="$1"
  if [[ "$raw" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    printf '%s.%s.%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
  else
    printf '%s\n' "$raw"
  fi
}

MANIFEST_TMP="$(mktemp)"
trap 'rm -f "$MANIFEST_TMP"' EXIT
git show "${SRC}:ratchet-manifest.json" > "$MANIFEST_TMP"

# Framework paths for the profile(s) recorded in .ratchet-install.json —
# `core` is always included, same convention as scripts/bootstrap.sh.
LIST="$(node -e '
  const fs = require("fs");
  const [manifestFile, installFile] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const install = JSON.parse(fs.readFileSync(installFile, "utf8"));
  const profiles = new Set(["core", ...(install.profiles || [])]);
  for (const entry of manifest.files || []) {
    if (entry.class === "framework" && profiles.has(entry.profile)) console.log(entry.path);
  }
' "$MANIFEST_TMP" "$INSTALL_FILE")"

PATHS=()
while IFS= read -r p; do [ -n "$p" ] && PATHS+=("$p"); done <<< "$LIST"
[ "${#PATHS[@]}" -gt 0 ] || die "no framework files matched the installed profile(s) in $INSTALL_FILE."

echo "Updating framework files from $SRC ..."
git checkout "$SRC" -- "${PATHS[@]}"

if [ -x ./setup.sh ]; then ./setup.sh >/dev/null 2>&1 && echo "Skill mirrors re-synced."; fi

# Record the new version (prefer upstream's .ratchet-version if present)
NEWVER="$(normalize_version "$REF")"
if git cat-file -e "${SRC}:.ratchet-version" 2>/dev/null; then
  NEWVER="$(normalize_version "$(git show "${SRC}:.ratchet-version" | head -n1 | tr -d '[:space:]')")"
fi
printf '%s\n' "$NEWVER" > .ratchet-version

node -e '
  const fs = require("fs");
  const [installFile, ver] = process.argv.slice(1);
  const install = JSON.parse(fs.readFileSync(installFile, "utf8"));
  install.version = ver;
  fs.writeFileSync(installFile, JSON.stringify(install, null, 2) + "\n");
' "$INSTALL_FILE" "$NEWVER"

echo
echo "Ratchet framework updated to: $NEWVER"
echo "Untouched (project-owned/generated): GATES.md, memory/, plan/ issues, .env, .env.example, README.md, LICENSE, .gitignore, your code."
echo "Next: review 'git diff', and if your stack changed, re-run /ratchet-init to refresh GATES.md."
