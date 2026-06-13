#!/usr/bin/env bash
# Cross-tool skill installer for the agentic factory.
# Canonical source: .agents/skills/  (read directly by Codex and Antigravity)
# This script mirrors the skills to the locations each tool expects.
#
# Usage:
#   ./setup.sh                 # sync repo-local mirrors (.claude/skills, plugin/skills)
#   ./setup.sh user-claude     # also install to ~/.claude/skills  (Claude Code, all projects)
#   ./setup.sh user-agents     # also install to ~/.agents/skills  (Codex/Antigravity, all projects)
set -euo pipefail
SRC=".agents/skills"
[ -d "$SRC" ] || { echo "Run from the repo root (no $SRC found)."; exit 1; }

mirror () {  # mirror SKILL.md files (skip Codex-only agents/openai.yaml in non-.agents targets)
  local dest="$1" keep_yaml="$2"
  mkdir -p "$dest"
  for s in "$SRC"/*/; do
    n=$(basename "$s"); mkdir -p "$dest/$n"
    cp "$s/SKILL.md" "$dest/$n/SKILL.md"
    if [ "$keep_yaml" = "yes" ] && [ -f "$s/agents/openai.yaml" ]; then
      mkdir -p "$dest/$n/agents"; cp "$s/agents/openai.yaml" "$dest/$n/agents/openai.yaml"
    fi
  done
}

# Always refresh repo-local mirrors so all three tools work on clone.
mirror ".claude/skills" no
mirror "plugin/skills" no
echo "Synced repo-local skills (.claude/skills, plugin/skills) from $SRC."

case "${1:-}" in
  user-claude) mirror "$HOME/.claude/skills" no; echo "Installed to ~/.claude/skills" ;;
  user-agents) mirror "$HOME/.agents/skills" yes; echo "Installed to ~/.agents/skills" ;;
  "" ) : ;;
  * ) echo "Unknown option: $1"; exit 1 ;;
esac
echo "Done. Restart your agent to pick up skill changes."
