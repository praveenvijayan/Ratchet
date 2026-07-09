---
title: Ship every workflow-invoked script in ratchet-update
priority: high
blocked_by: []
---

`scripts/ratchet-update.sh` pulls `.github/workflows/` but its `FRAMEWORK_PATHS`
list still names only the original five scripts. The six workflows now invoke
ten scripts the updater never delivers (`criteria.mjs`, `run-gates.mjs`,
`pr-size-check.mjs`, `sweep-lease.mjs`, `sweep-stale-claims.mjs`,
`unblock-dependents.mjs`, `verify-issue-body.mjs`, `release.mjs`,
`ratchet-metrics.mjs`, `archive-closed-plans.mjs`) — and `plan-sync.mjs` now
imports `criteria.mjs`, so an updated consumer repo breaks on its very next
sync. DOCS.md also claims the updater pulls `scripts/*`, which the script
contradicts.

## Acceptance criteria
- [ ] After an update, every `node scripts/<file>` referenced by any shipped workflow resolves in the consumer repo
- [ ] A test fails when a script referenced by `.github/workflows/*.yml` (or imported by a shipped script) is missing from `FRAMEWORK_PATHS`, so the list can never silently drift again
- [ ] DOCS.md's updater table matches the paths the script actually pulls
- [ ] The updater's closing hint names `/ratchet-init`, not the nonexistent `/factory-init`
