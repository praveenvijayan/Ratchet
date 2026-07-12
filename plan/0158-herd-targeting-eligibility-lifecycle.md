---
title: Herd targeting eligibility reporting and scoped-run lifecycle
priority: medium
labels: [scripts, herd]
blocked_by: [0157-herd-direct-issue-targeting]
---

Second slice of direct issue targeting (split from issue #350): make the
scoped run observable and finite. 0157 filters dispatch safely but skips
ineligible targets silently and polls forever; this issue adds per-issue
eligibility reasons and the terminal-exit condition.

## Acceptance criteria
- [ ] A requested issue that is closed, `state:blocked`, not `state:ready`, or already present in the state file is reported with a per-issue reason and an escalation entry, and is never spawned
- [ ] When every requested issue is ineligible, the supervisor exits non-zero with the per-issue reasons and zero workers spawned
- [ ] A scoped run exits once every target issue has reached a terminal status in the state file, rather than polling forever
- [ ] Every criterion above has exactly one test named after it

## Test notes
- a target issue closing mid-run is treated as terminal, reported, and the scoped run exits when the remaining targets finish
