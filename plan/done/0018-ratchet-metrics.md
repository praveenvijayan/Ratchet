---
title: Add a read-only ratchet-metrics skill for loop health
priority: low
blocked_by: []
---

No cycle time, gate-failure rate, rework rate, sweep frequency, or queue-depth
metrics exist — you can't tune a delivery mechanism you can't measure. All the
data already lives in GitHub issue timelines and PRs, so this fits the
no-external-service philosophy.

## Acceptance criteria
- [ ] A read-only `/ratchet-metrics` skill reports cycle time (ready→merged), rework rate, sweep count, and queue depth by state, aggregated from GitHub data via `gh`
- [ ] It runs with the existing `gh` auth only — no external service, and it never mutates issues, labels, files, or anything else
- [ ] A repo with little or no history yields a clear "not enough data" message per metric, never an error or a misleading zero
