---
name: ratchet-metrics
description: Report loop health from GitHub data — cycle time (ready→merged), rework rate, stale-claim sweep count, and queue depth by state. Read-only, uses your existing gh auth only, and never mutates an issue, label, file, or anything else. Use to see whether the delivery loop is flowing and where it stalls. Aggregates from issue timelines via scripts/ratchet-metrics.mjs.
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(gh:*)
---

# Ratchet metrics — is the loop healthy?

A **read-only** report. It never creates, edits, labels, branches, commits, or
closes anything — it only reads issue timelines and prints numbers. All data
comes from GitHub via your existing `gh` auth; there is no external service.

What it reports:
- **Cycle time (ready → merged)** — median time from an issue first reaching
  `state:ready` to being closed as completed (merged via `Closes #N`).
- **Rework rate** — share of completed issues that passed through
  `state:changes-requested` at least once.
- **Stale-claim sweeps** — how many times `sweep-stale-claims` requeued an
  abandoned claim (counted from its `Stale claim swept:` comments).
- **Queue depth by state** — open issues tallied across the `state:*` labels.

## Preflight

Confirm, and STOP with guidance if anything is missing:

- `gh auth status` is authenticated (the run uses `gh auth token`), or
  `GITHUB_PAT` is set in `.env`.
- `node --version` is 20 or newer (the script uses global `fetch`).
- `scripts/ratchet-metrics.mjs` exists at the repo root.

## Run

From the repository root, run exactly:

```
[ -f .env ] && set -a && . ./.env && set +a
GITHUB_TOKEN="${GITHUB_PAT:-${GITHUB_TOKEN:-$(gh auth token)}}" \
GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner -q .nameWithOwner)" \
node scripts/ratchet-metrics.mjs
```

Tune the scan window with `METRICS_LIMIT` (default 200 most-recent issues) for
large or long-lived repos. Never print the token value.

## Report

Relay the script's output, then add one plain-language read of loop health, e.g.
"cycle time is low and rework is 0% — the loop is flowing" or "queue depth is
piling up in `state:in-review`, so the bottleneck is human review, not agents."
When a metric shows **"not enough data"**, say the repo is too young to measure
it yet — do not invent a number.

## Hard rules

- Read-only. Never change labels, issues, files, branches, or anything else —
  the script issues GET requests only.
- A "not enough data" line is a valid, correct result on a young repo, never an
  error to work around.
