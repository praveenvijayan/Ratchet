---
title: Aggregate repeated adapter failures into one per-adapter alert
priority: medium
labels: [herd]
blocked_by: []
---

When an adapter is broken, every dispatch through it fails separately — six
`dispatch-failed` rows today, all `opencode-*`, presented as six unrelated
problems. The pattern is the signal: the dashboard should say "adapter
opencode-glm failed 3/3 dispatches", and show per-adapter attempt/failure
stats so the worst adapter is visible at a glance.

## Acceptance criteria
- [ ] An adapter whose recent dispatches all failed (at or above a small threshold) is surfaced as one aggregate alert naming the adapter and its failure ratio, alongside — not multiplying — the individual escalations
- [ ] A per-adapter breakdown shows dispatches, failures, and successes computed from the event stream
- [ ] An adapter with a mix of failures and successes is not flagged as broken
- [ ] Adapters with no recorded dispatches are omitted from the breakdown rather than shown as 0/0
- [ ] Every criterion above has exactly one test named after it

## Notes
Per-adapter cost aggregation belongs with the usage-metrics work
(0075/0076-herd-dashboard-usage-metrics), not here — this issue is failure
visibility only.
