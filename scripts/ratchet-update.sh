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

VERSION_FILE=".ratchet-version"
# The command a host runs to reinstall from scratch — named verbatim whenever
# adoption can't proceed, so the user never has to reverse-engineer it.
REINSTALL_CMD="bash scripts/bootstrap.sh --version <tag>"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repo."
# A missing $INSTALL_FILE is no longer fatal: if this repo carries a readable
# $VERSION_FILE, the adoption step below reconstructs the record from that
# pinned release before the manifest-aware update runs (issue #398).

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

# Adoption — reconstruct a missing install record from the pinned release.
# A repo that got Ratchet by direct copy (not scripts/bootstrap.sh) has the
# framework files and a .ratchet-version but no .ratchet-install.json, so the
# manifest-aware selection below has nothing to read. Rather than force a full
# reinstall, rebuild the record from a clean checkout of the RECORDED version:
# record each present framework path's pristine hash (so a later run still
# detects local edits) and never touch the working tree. Requires a readable
# .ratchet-version whose release is fetchable; otherwise name the reinstall
# command and stop — never a stack trace. (issue #398)
if [ ! -f "$INSTALL_FILE" ]; then
  [ -r "$VERSION_FILE" ] \
    || die "no $INSTALL_FILE and no readable $VERSION_FILE to adopt from — reinstall with: $REINSTALL_CMD"
  RAWVER="$(head -n1 "$VERSION_FILE" | tr -d '[:space:]')"
  RECVER="$(normalize_version "$RAWVER")"
  [ -n "$RECVER" ] \
    || die "no $INSTALL_FILE and $VERSION_FILE is empty — reinstall with: $REINSTALL_CMD"
  echo "No $INSTALL_FILE found — adopting this install from recorded version $RECVER ..."
  git fetch --quiet ratchet --tags 2>/dev/null || true
  # .ratchet-version is stored normalized (no leading v) but release tags may
  # carry one — try both forms when resolving the recorded release.
  REC_SRC=""
  for cand in "ratchet/$RECVER" "$RECVER" "ratchet/v$RECVER" "v$RECVER" "ratchet/$RAWVER" "$RAWVER"; do
    if git rev-parse --verify --quiet "${cand}^{commit}" >/dev/null; then REC_SRC="$cand"; break; fi
  done
  [ -n "$REC_SRC" ] \
    || die "cannot fetch recorded release '$RAWVER' to adopt from — reinstall with: $REINSTALL_CMD"
  git cat-file -e "${REC_SRC}:ratchet-manifest.json" 2>/dev/null \
    || die "recorded release '$RECVER' has no ratchet-manifest.json to adopt from — reinstall with: $REINSTALL_CMD"

  ADOPT_DIR="$(mktemp -d)"
  trap 'rm -f "$MANIFEST_TMP"; rm -rf "$ADOPT_DIR"' EXIT
  git archive "$REC_SRC" | tar -x -C "$ADOPT_DIR"

  # Compare each present framework path against its pristine release content:
  # record the pristine hash for all of them (what a clean install would store),
  # and report — but never overwrite — any the host has locally modified.
  node -e "$HASH_FN"'
    const fs = require("fs"), path = require("path");
    const [pristineRoot, installFile, ver] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(path.join(pristineRoot, "ratchet-manifest.json"), "utf8"));
    const fw = (manifest.files || []).filter((e) => e.class === "framework");
    // Profiles present on disk (core always). A profile counts as installed if
    // at least one of its framework paths exists in this repo.
    const present = new Set(["core"]);
    for (const e of fw) if (fs.existsSync(e.path)) present.add(e.profile);
    const hashes = {}, installed = [], modified = [];
    for (const e of fw) {
      if (!present.has(e.profile) || !fs.existsSync(e.path)) continue;  // not installed — leave for the update to add
      const pristine = hashPath(path.join(pristineRoot, e.path));
      if (pristine === null) continue;                                  // path not in this release
      hashes[e.path] = pristine;                                        // what a clean install would have recorded
      installed.push(e.path);
      if (hashPath(e.path) !== pristine) modified.push(e.path);         // host edited it — report, never touch
    }
    const generated = (manifest.files || [])
      .filter((e) => e.class === "generated" && fs.existsSync(e.path))
      .map((e) => e.path);
    const profiles = [...present].sort();
    fs.writeFileSync(installFile, JSON.stringify({ version: ver, profiles, installed, generated, hashes }, null, 2) + "\n");
    for (const m of modified) console.error(`  adopt: kept local edit (left untouched): ${m}`);
    console.error(`  adopt: recorded ${installed.length} framework path(s) for profile(s): ${profiles.join(", ")}`);
  ' "$ADOPT_DIR" "$INSTALL_FILE" "$RECVER"
  echo "Adopted $INSTALL_FILE at version $RECVER — continuing update to $REF."
fi

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

# Scaffold newly-added generated paths (e.g. mascots/) that the host's install
# record doesn't know about — an older install predates them. Existing paths
# are never touched (generated = scaffolded once, never overwritten).
NEW_GEN_PLAN="$(node -e '
  const fs = require("fs");
  const [manifestFile, installFile] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const install = JSON.parse(fs.readFileSync(installFile, "utf8"));
  const known = new Set(install.generated || []);
  const skip = new Set([".ratchet-version", ".claude/skills", "plugin/skills"]);
  const out = (manifest.files || [])
    .filter((e) => e.class === "generated" && !skip.has(e.path) && !known.has(e.path))
    .map((e) => e.path);
  process.stdout.write(out.join("\n"));
' "$MANIFEST_TMP" "$INSTALL_FILE")"

NEW_GEN_SCAFFOLDED=()
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  [ -e "$rel" ] && { echo "  skipped (already exists): $rel"; continue; }
  case "$rel" in
    mascots)
      git checkout "$SRC" -- "$rel"
      echo "  scaffolded: $rel"
      NEW_GEN_SCAFFOLDED+=("$rel")
      ;;
    *)
      echo "  skipped (generated by another tool): $rel"
      ;;
  esac
done <<< "$NEW_GEN_PLAN"

if [ -x ./setup.sh ]; then ./setup.sh >/dev/null 2>&1 && echo "Skill mirrors re-synced."; fi

# Record the new version (prefer upstream's .ratchet-version if present)
NEWVER="$(normalize_version "$REF")"
if git cat-file -e "${SRC}:.ratchet-version" 2>/dev/null; then
  NEWVER="$(normalize_version "$(git show "${SRC}:.ratchet-version" | head -n1 | tr -d '[:space:]')")"
fi
printf '%s\n' "$NEWVER" > .ratchet-version

node -e "$HASH_FN"'
  const fs = require("fs");
  const sep = process.argv.indexOf("--");
  const [installFile, ver] = process.argv.slice(1);
  const fwPaths = sep === -1 ? process.argv.slice(3) : process.argv.slice(3, sep);
  const newGen = sep === -1 ? [] : process.argv.slice(sep + 1);
  const install = JSON.parse(fs.readFileSync(installFile, "utf8"));
  install.version = ver;
  install.hashes = install.hashes || {};
  for (const p of fwPaths) install.hashes[p] = hashPath(p);
  if (newGen.length) install.generated = [...(install.generated || []), ...newGen];
  fs.writeFileSync(installFile, JSON.stringify(install, null, 2) + "\n");
' "$INSTALL_FILE" "$NEWVER" "${PATHS[@]}" -- "${NEW_GEN_SCAFFOLDED[@]:-}"

echo
echo "Ratchet framework updated to: $NEWVER"
echo "Untouched (project-owned/generated): GATES.md, memory/, mascots/, plan/ issues, .env, .env.example, README.md, LICENSE, .gitignore, your code."
echo "Next: review 'git diff', and if your stack changed, re-run /ratchet-init to refresh GATES.md."
