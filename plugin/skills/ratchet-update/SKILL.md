---
name: ratchet-update
description: Update the Ratchet framework files in this repo from upstream to a newer version, on a review branch. Pulls only framework paths (skills, workflows, scripts, AGENTS.md) and never touches project-owned files (GATES.md, memory/, plan issues, .env). Shows the diff and stops for human review; never commits or merges.
argument-hint: [optional version tag, e.g. v1.2.0; default is upstream main]
disable-model-invocation: true
allowed-tools: Bash(git:*), Bash(bash:*), Read
---

# Update Ratchet

Pull a newer version of the Ratchet framework into this repo, safely.

## Preflight

- Confirm this is a git repo and `scripts/ratchet-update.sh` exists.
- Confirm the working tree is **clean** (`git status --porcelain`). If it is
  dirty, STOP and ask the user to commit or stash first — the update overwrites
  framework files and uncommitted changes to them would be lost.
- Note the current version: `cat .ratchet-version` (may be absent on old installs).

## Run

1. Create a review branch:
   `git checkout -b ratchet-update/$(date +%Y%m%d)`
2. Run the updater with the requested ref (the argument, or `main` if none):
   `bash scripts/ratchet-update.sh <ref>`
   It pulls only framework paths, re-syncs skill mirrors, and bumps
   `.ratchet-version`. It does **not** touch `GATES.md`, `memory/`, your
   `plan/*.md` issues, `.env`, `README.md`, `LICENSE`, or `.gitignore`.

## Report, then stop

- Show `git diff --stat` and a short summary of what changed (framework only).
- If `AGENTS.md` or `GATES.md` semantics changed in this release, remind the
  user they can re-run `/factory-init` to refresh `GATES.md` from their stack.
- Do **not** commit, push, or merge. Hand the user the commands to finish:
  ```
  git add -A && git commit -m "Update Ratchet framework to <version>"
  git push -u origin ratchet-update/<date>   # then open a PR and review the diff
  ```

## Hard rules

- Framework paths only. Never overwrite `GATES.md`, `memory/`, plan issue files,
  or any project code — the updater already excludes them; do not add them.
- Never commit, push, or merge — the update is reviewed via a PR like any change.
- Always work on a branch, never directly on `main`.
- If the working tree is dirty, stop rather than risk clobbering local changes.
