#!/usr/bin/env bash
# Update the Ratchet FRAMEWORK files in this repo from upstream. Manifest- and
# profile-aware: reads ratchet-manifest.json at the target ref and pulls only
# the `framework` files for the profile(s) recorded in this project's
# .ratchet-install.json (written by scripts/bootstrap.sh) — never the whole
# tree, and never `generated`/project-owned paths (they are never selected).
#
# Usage:
#   ./scripts/ratchet-update.sh              # update from upstream main
#   ./scripts/ratchet-update.sh v1.2.0       # update to a specific tag
#   ./scripts/ratchet-update.sh --force      # also replace locally modified framework files
# Env:
#   RATCHET_REMOTE=<git url>                 # override upstream (default below)
set -euo pipefail

REMOTE_URL="${RATCHET_REMOTE:-https://github.com/praveenvijayan/Ratchet.git}"
REF="main"; FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) REF="$arg" ;;
  esac
done
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

# Shared by the plan (below) and commit (post-checkout) steps: hashes a file,
# or a directory as the sorted concatenation of its relative paths + bytes.
HASH_FN='function hashPath(p){const fs=require("fs"),path=require("path"),crypto=require("crypto");if(!fs.existsSync(p))return null;const h=crypto.createHash("sha256");if(fs.statSync(p).isFile()){h.update(fs.readFileSync(p));return h.digest("hex");}const files=[];(function walk(d){for(const n of fs.readdirSync(d).sort()){const f=path.join(d,n);fs.statSync(f).isDirectory()?walk(f):files.push(f);}})(p);for(const f of files.sort()){h.update(f);h.update(fs.readFileSync(f));}return h.digest("hex");}'

# Framework paths for the profile(s) recorded in .ratchet-install.json (`core`
# is always included, same convention as scripts/bootstrap.sh), each tagged
# new|same|modified — "modified" means the on-disk content no longer matches
# the hash this updater recorded the last time it wrote that path.
PLAN="$(node -e "$HASH_FN"'
  const fs = require("fs");
  const [manifestFile, installFile] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const install = JSON.parse(fs.readFileSync(installFile, "utf8"));
  const profiles = new Set(["core", ...(install.profiles || [])]);
  const hashes = install.hashes || {};
  for (const entry of manifest.files || []) {
    if (entry.class !== "framework" || !profiles.has(entry.profile)) continue;
    const current = hashPath(entry.path);
    const status = current === null ? "new" : hashes[entry.path] && hashes[entry.path] !== current ? "modified" : "same";
    console.log(`${entry.path}\t${status}`);
  }
' "$MANIFEST_TMP" "$INSTALL_FILE")"

PATHS=(); MODIFIED=()
while IFS=$'\t' read -r p status; do
  [ -n "$p" ] || continue
  PATHS+=("$p")
  [ "$status" = "modified" ] && MODIFIED+=("$p")
done <<< "$PLAN"

if [ "${#MODIFIED[@]}" -gt 0 ] && [ "$FORCE" -ne 1 ]; then
  echo "ratchet-update: refusing to overwrite locally modified framework files (re-run with --force to replace them):" >&2
  for m in "${MODIFIED[@]}"; do echo "  modified: $m" >&2; done
  die "no files were changed."
fi

[ "${#PATHS[@]}" -gt 0 ] || die "no framework files matched the installed profile(s) in $INSTALL_FILE."

echo "Updating framework files from $SRC ..."
git checkout "$SRC" -- "${PATHS[@]}"
for m in "${MODIFIED[@]:-}"; do [ -n "$m" ] && echo "  replaced (--force): $m"; done

if [ -x ./setup.sh ]; then ./setup.sh >/dev/null 2>&1 && echo "Skill mirrors re-synced."; fi

# Record the new version (prefer upstream's .ratchet-version if present)
NEWVER="$(normalize_version "$REF")"
if git cat-file -e "${SRC}:.ratchet-version" 2>/dev/null; then
  NEWVER="$(normalize_version "$(git show "${SRC}:.ratchet-version" | head -n1 | tr -d '[:space:]')")"
fi
printf '%s\n' "$NEWVER" > .ratchet-version

node -e "$HASH_FN"'
  const fs = require("fs");
  const [installFile, ver, ...paths] = process.argv.slice(1);
  const install = JSON.parse(fs.readFileSync(installFile, "utf8"));
  install.version = ver;
  install.hashes = install.hashes || {};
  for (const p of paths) install.hashes[p] = hashPath(p);
  fs.writeFileSync(installFile, JSON.stringify(install, null, 2) + "\n");
' "$INSTALL_FILE" "$NEWVER" "${PATHS[@]}"

echo
echo "Ratchet framework updated to: $NEWVER"
echo "Untouched (project-owned/generated): GATES.md, memory/, plan/ issues, .env, .env.example, README.md, LICENSE, .gitignore, your code."
echo "Next: review 'git diff', and if your stack changed, re-run /ratchet-init to refresh GATES.md."
