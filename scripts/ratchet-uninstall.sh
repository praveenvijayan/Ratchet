#!/usr/bin/env bash
# ratchet-uninstall.sh — remove exactly what scripts/bootstrap.sh installed.
#
# Manifest-driven: reads .ratchet-install.json (written by bootstrap.sh) and
# removes only the paths it recorded — nothing host-owned is ever touched,
# because host files were never recorded there.
#
# SAFE BY DEFAULT:
#   • dry-run unless --yes (shows exactly what would be removed)
#   • a framework file the host locally modified since install (content hash
#     no longer matches the recorded one) is skipped, not removed
#   • "generated" files (GATES.md, memory/, .env.example, .ratchet-version,
#     skill mirrors) are kept unless explicitly named via --purge-memory or
#     --purge-generated=path,path
#   • plan/*.md (your issue specs) kept unless --purge-plans
#   • never deletes GitHub issues, labels, secrets, branches, or branch
#     protection — that is GitHub-side state (files only)
#
# Usage:
#   ./scripts/ratchet-uninstall.sh                        # dry-run
#   ./scripts/ratchet-uninstall.sh --yes                  # remove framework files
#   ./scripts/ratchet-uninstall.sh --yes --purge-memory    # also remove memory/
#   ./scripts/ratchet-uninstall.sh --yes --purge-plans     # also remove plan/*.md
#   ./scripts/ratchet-uninstall.sh --yes --purge-generated=GATES.md,.env.example
set -euo pipefail

DRY=1; PURGE_MEM=0; PURGE_PLANS=0; PURGE_GEN=""
for a in "$@"; do case "$a" in
  --yes) DRY=0;;
  --purge-memory) PURGE_MEM=1;;
  --purge-plans) PURGE_PLANS=1;;
  --purge-generated=*) PURGE_GEN="${a#--purge-generated=}";;
  -h|--help) sed -n '2,26p' "$0"; exit 0;;
  *) echo "unknown arg: $a" >&2; exit 2;;
esac; done

die(){ echo "ratchet-uninstall: $*" >&2; exit 1; }
note(){ printf '%s\n' "$*"; }

[ -f .ratchet-install.json ] || die "no .ratchet-install.json found — this project has no recorded Ratchet install manifest (it may predate the manifest-based installer, or Ratchet was copied in by hand). Nothing was changed: this script only removes what a recorded install listed. Reinstall with scripts/bootstrap.sh to get a manifest, or remove files by hand."

SHACMD=(sha256sum); command -v sha256sum >/dev/null 2>&1 || SHACMD=(shasum -a 256)
hash_path() {
  local p="$1"
  if [ -d "$p" ]; then
    ( cd "$p" && find . -type f -print0 | sort -z | xargs -0 "${SHACMD[@]}" ) | "${SHACMD[@]}" | awk '{print $1}'
  else
    "${SHACMD[@]}" "$p" | awk '{print $1}'
  fi
}

MANIFEST_JSON="$(node -e '
  const fs = require("fs");
  let m;
  try { m = JSON.parse(fs.readFileSync(".ratchet-install.json", "utf8")); }
  catch (e) { console.error("not valid JSON: " + e.message); process.exit(3); }
  const installed = m.installed || [];
  const generated = m.generated || [];
  const hashes = m.hashes || {};
  const lines = [];
  for (const p of installed) lines.push("I\t" + p + "\t" + (hashes[p] || ""));
  for (const p of generated) lines.push("G\t" + p + "\t");
  process.stdout.write(lines.join("\n"));
' 2>&1)" || die ".ratchet-install.json could not be read: $MANIFEST_JSON"

note "Ratchet uninstall — $([ "$DRY" = 1 ] && echo 'DRY RUN (nothing deleted; pass --yes to apply)' || echo 'APPLYING')"
note ""
note "Framework files (recorded in .ratchet-install.json):"
REMOVED=(); SKIPPED_MOD=0; GENERATED_REL=()
while IFS=$'\t' read -r kind rel recorded; do
  [ -n "$rel" ] || continue
  if [ "$kind" = "G" ]; then GENERATED_REL+=("$rel"); continue; fi
  if [ ! -e "$rel" ]; then note "  already gone: $rel"; continue; fi
  if [ -n "$recorded" ] && [ "$(hash_path "$rel")" != "$recorded" ]; then
    note "  KEPT (locally modified since install): $rel"
    SKIPPED_MOD=1
    continue
  fi
  if [ "$DRY" = 1 ]; then note "  would remove: $rel"
  else rm -rf "$rel"; note "  removed: $rel"; REMOVED+=("$rel"); fi
done <<< "$MANIFEST_JSON"

note ""
note "Generated files (kept by default):"
GEN_TO_PURGE=()
if [ "$PURGE_MEM" = 1 ]; then
  for rel in "${GENERATED_REL[@]:-}"; do [ "$rel" = "memory" ] && GEN_TO_PURGE+=("$rel"); done
fi
if [ -n "$PURGE_GEN" ]; then IFS=',' read -ra EXTRA <<< "$PURGE_GEN"; GEN_TO_PURGE+=("${EXTRA[@]}"); fi
if [ "${#GEN_TO_PURGE[@]}" -gt 0 ]; then
  for rel in "${GEN_TO_PURGE[@]}"; do
    [ -e "$rel" ] || { note "  already gone: $rel"; continue; }
    if [ "$DRY" = 1 ]; then note "  would remove: $rel"
    else rm -rf "$rel"; note "  removed: $rel"; REMOVED+=("$rel"); fi
  done
else
  for rel in "${GENERATED_REL[@]:-}"; do note "  KEPT: $rel"; done
  note "  (pass --purge-memory and/or --purge-generated=path,path to remove any)"
fi

note ""
if [ "$PURGE_PLANS" = 1 ]; then
  if [ "$DRY" = 1 ]; then note "  would remove: plan/*.md"
  else rm -f plan/*.md 2>/dev/null || true; note "  removed: plan/*.md"; fi
else
  note "  KEPT: plan/*.md (your issue specs) — pass --purge-plans to remove"
fi
note "  KEPT: .env (never removed)"

# Clean up now-empty directories the removals left behind (bottom-up).
if [ "$DRY" = 0 ]; then
  for rel in "${REMOVED[@]:-}"; do
    [ -n "$rel" ] || continue
    d="$(dirname "$rel")"
    while [ "$d" != "." ] && [ -d "$d" ] && [ -z "$(ls -A "$d" 2>/dev/null)" ]; do
      rmdir "$d"; note "  removed empty dir: $d"; d="$(dirname "$d")"
    done
  done
  # The install record itself is Ratchet's bookkeeping, not host content —
  # drop it once everything it listed is gone, so a full uninstall matches
  # the pre-install tree. Keep it if a modified file was skipped: it is still
  # the only record of what remains and what to check next time.
  if [ "$SKIPPED_MOD" = 0 ]; then rm -f .ratchet-install.json; fi
fi

note ""
note "NOT touched (GitHub-side — do these yourself, or use the /ratchet-uninstall skill):"
note "  • Issues: never deleted (they are your work items)."
note "  • Branch protection on main: left as-is (your safety setting)."
note "  • Labels / secret / variable / branches, if you want them gone:"
note "      for l in state:draft state:ready state:in-progress state:in-review \\"
note "               state:changes-requested state:blocked priority:high \\"
note "               priority:medium priority:low; do gh label delete \"\$l\" --yes; done"
note "      gh secret delete FACTORY_PAT 2>/dev/null; gh variable delete RATCHET_AUTO 2>/dev/null"
note "      git push origin --delete ratchet/planning 2>/dev/null"
note ""
[ "$DRY" = 1 ] && note "Dry run only. Re-run with --yes to apply." || \
  note "Done. If main is protected, commit this on a branch and merge via PR."
