---
title: Exclude generated files from the PR size check
priority: low
blocked_by: []
---

The size check counts raw additions/deletions and changed files from the PR
payload with no path exclusions. In any consumer project a lockfile
regeneration or generated artifact blows the 400-line cap and hard-fails a
legitimately small PR, pushing agents into a pointless split-and-requeue.

## Acceptance criteria
- [ ] GATES.md supports exclude patterns for the size check; changes under excluded paths do not count toward either threshold
- [ ] Common lockfiles (package-lock.json, pnpm-lock.yaml, yarn.lock, Cargo.lock, poetry.lock, go.sum) are excluded by default
- [ ] The failure message notes which exclusions were applied, so an over-limit verdict is auditable
