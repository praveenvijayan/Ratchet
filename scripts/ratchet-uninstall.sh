#!/usr/bin/env bash
# ratchet-uninstall.sh — remove Ratchet from this project.
#
# SAFE BY DEFAULT:
#   • dry-run unless --yes (shows exactly what would be removed)
#   • preserves YOUR data (memory/, plan/*.md, .env) unless you opt in
#   • removes generically-named files (CLAUDE.md, setup.sh, DOCS.md, …) only when
#     they are recognizably Ratchet's; otherwise keeps them and tells you
#   • never deletes GitHub issues, labels, secrets, branches, or branch
#     protection — that is GitHub-side state (the /ratchet-uninstall skill offers
#     to clean it up with your confirmation; this script only touches files)
#
# Usage:
#   ./scripts/ratchet-uninstall.sh                     # dry-run
#   ./scripts/ratchet-uninstall.sh --yes               # remove framework files
#   ./scripts/ratchet-uninstall.sh --yes --purge-memory  # also remove memory/
#   ./scripts/ratchet-uninstall.sh --yes --purge-plans   # also remove plan/*.md
set -euo pipefail

DRY=1; PURGE_MEM=0; PURGE_PLANS=0
for a in "$@"; do case "$a" in
  --yes) DRY=0;;
  --purge-memory) PURGE_MEM=1;;
  --purge-plans) PURGE_PLANS=1;;
  -h|--help) sed -n '2,20p' "$0"; exit 0;;
  *) echo "unknown arg: $a"; exit 2;;
esac; done

note(){ printf '%s\n' "$*"; }
act(){ for p in "$@"; do [ -e "$p" ] || continue
  if [ "$DRY" = 1 ]; then note "  would remove: $p"; else rm -rf "$p"; note "  removed: $p"; fi
done; }
# remove a generically-named file ONLY if it matches a Ratchet marker
act_if(){ local p="$1" m="$2"; [ -e "$p" ] || return 0
  if grep -qF "$m" "$p" 2>/dev/null; then act "$p"
  else note "  KEPT (not Ratchet's, or has your edits): $p"; fi; }

note "Ratchet uninstall — $([ "$DRY" = 1 ] && echo 'DRY RUN (nothing deleted; pass --yes to apply)' || echo 'APPLYING')"
note ""
note "Framework files (Ratchet-owned, unambiguous):"
act AGENTS.md GATES.md .ratchet-version .ratchet
act .github/workflows/plan-sync.yml .github/workflows/unblock-dependents.yml \
    .github/workflows/sweep-stale-claims.yml .github/workflows/ratchet-run.yml
act scripts/plan-sync.mjs scripts/ratchet-update.sh \
    scripts/ratchet-watch.sh scripts/ratchet-watch.mjs scripts/ratchet-uninstall.sh
act plan/README.md
for base in .agents/skills .claude/skills plugin/skills; do
  [ -d "$base" ] && act "$base"/ratchet-*
done

note ""
note "Generically-named files (removed only if recognizably Ratchet's):"
act_if CLAUDE.md  "same manual as Codex and Antigravity"
act_if GEMINI.md  "Antigravity reads"
act_if DOCS.md    "Ratchet — Complete Documentation"
act_if setup.sh   "Cross-tool skill installer"
act_if .env.example "Fine-grained Personal Access Token"
act_if .claude-plugin/marketplace.json "ratchet"

note ""
note "Your data:"
if [ "$PURGE_PLANS" = 1 ]; then act plan/*.md; else note "  KEPT: plan/*.md (your issue specs) — pass --purge-plans to remove"; fi
if [ "$PURGE_MEM" = 1 ]; then act memory; else note "  KEPT: memory/ (USER.md, ARCHITECTURE.md, MEMORY.md) — pass --purge-memory to remove"; fi
note "  KEPT: .env (never removed)"

# Remove now-empty Ratchet directories (leaves any dir that still holds your files)
for d in .agents/skills .claude/skills plugin/skills plugin .claude-plugin .agents .claude plan; do
  [ -d "$d" ] && [ -z "$(ls -A "$d" 2>/dev/null)" ] && act "$d"
done

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
