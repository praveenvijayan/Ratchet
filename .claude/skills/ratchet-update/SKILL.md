---
name: ratchet-update
description: Update Ratchet framework files in this repo to a newer upstream version, on a review branch. Manifest- and profile-aware — pulls only the `framework` files for the profile(s) recorded in this project's `.ratchet-install.json`, never the whole tree, and never project-owned or generated paths (`GATES.md`, `memory/`, plan issues, `.env`). Shows a diff and stops for human review; never commits or merges.
argument-hint: [optional version tag, e.g. v1.2.0; default upstream main]
disable-model-invocation: true
allowed-tools: Bash(git:*), Bash(bash:*), Read
---

# Update Ratchet

Pull a newer version of the Ratchet framework into this repo, safely.

## Preflight

- Confirm this is a git repo and `scripts/ratchet-update.sh` exists.
- Confirm `.ratchet-install.json` exists at the repo root. It's written by
  `scripts/bootstrap.sh` and records which profiles are installed and a
  content hash per framework file. Without it the updater has nothing to
  select from and refuses with a clear error — if it's missing (pre-manifest
  install, or Ratchet copied in by hand), stop and tell the user to reinstall
  with `scripts/bootstrap.sh` instead of updating.
- Confirm the working tree is **clean** (`git status --porcelain`). If dirty,
  STOP and ask the user to commit or stash first — update overwrites
  framework files and uncommitted changes to them would be lost.
- Note the current version: `cat .ratchet-version` (may be absent on very old
  installs).

## Run

1. Create a review branch: `git checkout -b ratchet-update/$(date +%Y%m%d)`
2. Run the updater with the requested ref as its argument (`main` if none):
   `bash scripts/ratchet-update.sh <ref>`

   The updater reads `ratchet-manifest.json` at that ref and selects every
   `framework`-class file whose profile is `core` or one of the profiles
   listed in this project's `.ratchet-install.json` — nothing else. For each
   selected path it compares the current on-disk content against the hash
   recorded from the last update (or install): a path whose content still
   matches is updated normally; a path whose content has **diverged**
   (locally modified since install) is **skipped by default** and listed
   under "refusing to overwrite locally modified framework files" — pass
   `--force` to the updater (`bash scripts/ratchet-update.sh <ref> --force`)
   to replace those too. It never touches `generated`-class paths (`GATES.md`,
   `memory/`, `.env.example`) or anything not in the manifest (your
   `plan/*.md` issues, `.env`, `README.md`, `LICENSE`, `.gitignore`, your
   code) — `.ratchet-version` is the one exception, rewritten directly to the
   new version. It does re-sync the skill mirrors (`.claude/skills`,
   `plugin/skills`) by running `./setup.sh`, since those must stay
   byte-identical to the just-updated `.agents/skills` source, and it updates
   `.ratchet-install.json`'s recorded version and hashes.

## Report, then stop

- Show `git diff --stat` for a short summary of what changed (framework
  files only, plus any locally-modified files replaced under `--force`).
- If `AGENTS.md` or `GATES.md` semantics changed in the release, remind the
  user they can re-run `/ratchet-init` to refresh `GATES.md` from their stack.
- Do **not** commit, push, or merge. Hand the user the commands to finish:
  ```
  git add -A && git commit -m "Update Ratchet framework to <version>"
  git push -u origin ratchet-update/<date>
  gh pr create --title "Update Ratchet framework to <version>" --fill
  ```
  `GATES.md`, `memory/`, and their `plan/*.md` are untouched by the updater,
  so the manifest already excludes them from this diff.

## Hard rules

- Always work on a branch, never directly on `main`.
- If the working tree was dirty at preflight, stop rather than risk
  clobbering local changes.
- Never commit, push, or merge — the update is reviewed via PR like any
  other change.
