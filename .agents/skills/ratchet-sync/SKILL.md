---
name: ratchet-sync
description: Compile plan/*.md into GitHub issues immediately by running scripts/plan-sync.mjs locally. This is the LOCAL / no-PR escape hatch — the normal path is to merge the rolling planning PR (which runs plan-sync on main). Use this only when you are NOT using the planning-PR flow (e.g. an unprotected main, or fast solo iteration) and want issues created from your working-tree plan files now. Idempotent — safe to run repeatedly.
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(gh:*)
---

# Plan sync (local / no-PR path)

> Normally you do **not** run this. Plan files reach issues by merging the
> rolling planning PR opened by `/ratchet-plan` — the `plan-sync` workflow then
> runs on `main`. Use this skill only when you are deliberately working without
> that PR flow (unprotected `main`, or quick solo iteration) and want issues
> created from your **working-tree** plan files right now, before any merge.

Run the deterministic compiler against `plan/*.md` now, using local credentials,
so issues are created/updated without going through the planning PR.

## Preflight

Confirm, and STOP with guidance if anything is missing:

- A token is available: either `GITHUB_PAT` in `.env`, or `gh auth status` is
  authenticated (the run falls back to `gh auth token`).
- `node --version` is 20 or newer (the script uses global `fetch`).
- `scripts/plan-sync.mjs` exists at the repo root.

## Run

From the repository root, run exactly:

```
[ -f .env ] && set -a && . ./.env && set +a
GITHUB_TOKEN="${GITHUB_PAT:-${GITHUB_TOKEN:-$(gh auth token)}}" \
GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner -q .nameWithOwner)" \
node scripts/plan-sync.mjs
```

This prefers the PAT from `.env`, then any `GITHUB_TOKEN` in the environment,
then the local `gh` token. Never print the token value.

## Report

Relay the script's output, then summarise: how many issues were `CREATE`d,
`UPDATE`d, held (`HOLD`, work already started), or skipped (`SKIP`, missing
`title`/`priority`). Name any skipped file and why so the user can fix it.

## Hard rules

- Only creates/updates issues from plan files. Never commits, pushes, merges, or
  closes anything.
- A skipped file is a plan problem, not a script problem. Fix the `plan/*.md`,
  never the script.
