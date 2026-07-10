#!/usr/bin/env bash
# bootstrap.sh — install Ratchet into a host project from a pinned release.
# Downloads a pinned Ratchet ref, reads ratchet-manifest.json, and installs only
# the `framework` files the selected profile(s) need — safely, visibly, and
# non-destructively. It NEVER creates GitHub labels/secrets/issues/branch
# protection and never copies your `.env` or local settings (those are not in
# the manifest, so they are never selected).
#
# Usage:
#   scripts/bootstrap.sh --version <tag> [--profile core,watcher,...] [--dry-run] [--force]
# Env:
#   RATCHET_REMOTE=<git url>   # override upstream (default below)
set -euo pipefail

REMOTE_URL="${RATCHET_REMOTE:-https://github.com/praveenvijayan/Ratchet.git}"
REF=""; PROFILES="core"; DRY=0; FORCE=0
while [ $# -gt 0 ]; do case "$1" in
  --version) REF="${2:-}"; shift 2;;
  --profile) PROFILES="${2:-}"; shift 2;;
  --dry-run) DRY=1; shift;;
  --force)   FORCE=1; shift;;
  -h|--help) sed -n '2,14p' "$0"; exit 0;;
  *) echo "bootstrap: unknown argument: $1" >&2; exit 2;;
esac; done

die(){ echo "bootstrap: $*" >&2; exit 1; }

# AC: must be inside a git repo — checked BEFORE downloading anything.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "not a git repository — run bootstrap from inside your project's git repo. Nothing was downloaded."

# AC: the version must be explicit so installs are reproducible.
[ -n "$REF" ] || die "no --version given. Pass --version <tag> for a reproducible install, or --version main to track latest (not reproducible)."
[ "$REF" = "main" ] && echo "bootstrap: WARNING — --version main is not reproducible; pin a release tag for a repeatable install." >&2

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
SRC="$TMP/src"

# AC: download into a temp dir first; the host is untouched until every check
# passes, so a failed download can never leave a partial install.
echo "bootstrap: fetching $REF from $REMOTE_URL ..."
git clone --quiet --depth 1 --branch "$REF" "$REMOTE_URL" "$SRC" 2>/dev/null \
  || die "could not resolve or fetch ref '$REF' from $REMOTE_URL — nothing was installed."
[ -f "$SRC/ratchet-manifest.json" ] || die "downloaded ref '$REF' has no ratchet-manifest.json — cannot select files."

# Framework paths for the selected profile(s) — `core` is always included.
LIST="$(node -e '
  const fs = require("fs");
  const [mf, prof] = process.argv.slice(1);
  let m;
  try { m = JSON.parse(fs.readFileSync(mf, "utf8")); } catch (e) { console.error("manifest is not valid JSON: " + e.message); process.exit(3); }
  const want = new Set(["core"]);
  for (const p of prof.split(",").map((s) => s.trim()).filter(Boolean)) want.add(p);
  for (const p of want) if (!m.profiles || !m.profiles[p]) { console.error("unknown profile: " + p); process.exit(4); }
  const out = (m.files || []).filter((e) => e.class === "framework" && want.has(e.profile)).map((e) => e.path);
  process.stdout.write(out.join("\n"));
' "$SRC/ratchet-manifest.json" "$PROFILES")" || die "manifest is invalid or a requested profile is unknown (profiles: $PROFILES)."

# Build the install + conflict lists, validating each path stays inside the target.
INSTALL=(); CONFLICTS=(); SKIPPED=()
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  # AC: reject any manifest path that would escape the target directory.
  case "/$rel/" in */../*) die "refusing path that escapes the target directory: $rel";; esac
  case "$rel" in /*) die "refusing absolute manifest path: $rel";; esac
  if [ ! -e "$SRC/$rel" ]; then SKIPPED+=("$rel"); continue; fi
  INSTALL+=("$rel")
  [ -e "$rel" ] && CONFLICTS+=("$rel")
done <<< "$LIST"

# AC: --dry-run reports and writes nothing.
if [ "$DRY" -eq 1 ]; then
  echo "bootstrap: DRY RUN (profiles: core${PROFILES:+,$PROFILES}) — nothing will be written."
  for rel in "${INSTALL[@]:-}"; do [ -n "$rel" ] || continue
    if [ -e "$rel" ]; then echo "  would conflict: $rel (needs --force)"; else echo "  would create:   $rel"; fi
  done
  for rel in "${SKIPPED[@]:-}"; do [ -n "$rel" ] && echo "  would skip:     $rel (absent from release)"; done
  echo "bootstrap: dry run complete — host project unchanged."
  exit 0
fi

# AC: an existing host file is never overwritten without --force. List every
# conflict and exit non-zero, changing nothing.
if [ "${#CONFLICTS[@]}" -gt 0 ] && [ "$FORCE" -ne 1 ]; then
  echo "bootstrap: refusing to overwrite existing files (re-run with --force to replace them):" >&2
  for c in "${CONFLICTS[@]}"; do echo "  conflict: $c" >&2; done
  die "no files were changed."
fi

for rel in "${INSTALL[@]:-}"; do
  [ -n "$rel" ] || continue
  mkdir -p "$(dirname "$rel")"
  rm -rf "$rel"
  cp -R "$SRC/$rel" "$rel"
  echo "  installed: $rel"
done

# Record the version and an installation manifest of every path we wrote.
VER="$REF"
if [[ "$REF" =~ ^v?([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then VER="${BASH_REMATCH[1]}"; fi
printf '%s\n' "$VER" > .ratchet-version
node -e '
  const fs = require("fs");
  const [ver, prof, ...paths] = process.argv.slice(1);
  const profiles = ["core", ...prof.split(",").map((s) => s.trim()).filter(Boolean)].filter((v, i, a) => a.indexOf(v) === i);
  fs.writeFileSync(".ratchet-install.json", JSON.stringify({ version: ver, profiles, installed: paths }, null, 2) + "\n");
' "$VER" "$PROFILES" "${INSTALL[@]:-}"

echo
echo "bootstrap: Ratchet $VER installed (profiles: ${PROFILES}). Recorded in .ratchet-install.json."
echo "Next steps:"
echo "  1. ./setup.sh       # generate the skill mirrors your agent reads"
echo "  2. /ratchet-init    # detect your stack and fill in GATES.md"
