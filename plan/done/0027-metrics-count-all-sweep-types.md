---
title: Count all three sweep types in ratchet-metrics
priority: low
blocked_by: []
---

`ratchet-metrics.mjs` counts sweep events by matching comments that start with
`Stale claim swept:` — but the extended sweep posts three distinct prefixes
(`Stale claim swept:`, `Stale review swept:`, `Stale rework swept:`). The
metric silently misses two of the three, understating how often the loop
requeues abandoned work — the exact signal the metric exists to surface.

## Acceptance criteria
- [ ] Each of the three sweep comment prefixes emitted by `sweep-stale-claims.mjs` is counted as a sweep event
- [ ] A shared definition (or drift test) ties the metric's prefixes to the sweep script's, so adding a fourth sweep type cannot silently undercount again
