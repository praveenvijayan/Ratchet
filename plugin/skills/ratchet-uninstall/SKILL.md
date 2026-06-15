---
name: ratchet-uninstall
description: Cleanly remove Ratchet from this project. Removes the framework files (preserving your memory/ and plan files unless you opt in), and offers to clean up the GitHub-side state (labels, secret, variable, planning branch) with your confirmation. Never deletes issues or branch protection. Does the file removal on a branch so it goes through the PR gate.
disable-model-invocation: true
allowed-tools: Read, Bash(ls:*), Bash(bash:*), Bash(git:*), Bash(gh:*)
---

# Uninstall Ratchet

Remove Ratchet from this repo safely. Removal spans three different things — be
explicit about each.

## 1. Preview

Run the teardown in dry-run and show the user exactly what would be removed:
`bash scripts/ratchet-uninstall.sh`. Explain the three categories:
- **Framework files** — removed (skills, workflows, scripts, `AGENTS.md`,
  `GATES.md`, pointers, the format contract).
- **Your data** — `memory/` and `plan/*.md` are **kept by default**. Ask whether
  to also remove them (`--purge-memory`, `--purge-plans`). `.env` is never removed.
- **Generically-named files** (`CLAUDE.md`, `GEMINI.md`, `DOCS.md`, `setup.sh`,
  `.env.example`) — removed only if recognizably Ratchet's; otherwise kept.

## 2. Confirm, then remove files on a branch

`main` is normally protected, so the removal must go through a PR — do not push
to `main`.

1. `git checkout main && git fetch origin && git pull --ff-only`
2. `git checkout -b ratchet-uninstall`
3. Run with the user's choices, e.g. `bash scripts/ratchet-uninstall.sh --yes`
   (add `--purge-memory` / `--purge-plans` only if the user agreed).
4. `git add -A && git commit -m "Remove Ratchet"` and push the branch.
5. Open a PR and tell the user to review and merge it to complete the file
   removal.

## 3. GitHub-side cleanup (ask per item; never assume)

These are not files and don't go through the PR. Offer each, and act only on an
explicit yes:
- **Labels** — delete the nine `state:*` / `priority:*` labels
  (`gh label delete <name> --yes`). Deleting a label just unlabels issues; it
  does not delete them.
- **Secret / variable** — `gh secret delete FACTORY_PAT`,
  `gh variable delete RATCHET_AUTO`.
- **Branches** — delete `ratchet/planning` and any merged `agent/issue-*`
  branches (`git push origin --delete <branch>`).
- **Open planning PR** — offer to close it (`gh pr close`).

## Hard rules

- **Never delete issues.** They are the user's work items, not Ratchet's.
- **Never remove branch protection.** It's the user's safety setting — only
  remind them it exists if they want it gone.
- Preserve `memory/` and `plan/*.md` unless the user explicitly opts to purge.
- Never remove a generically-named file that isn't recognizably Ratchet's.
- Do file removal on a branch via PR (main is protected); only the GitHub-side
  cleanup happens immediately, and only with per-item confirmation.
