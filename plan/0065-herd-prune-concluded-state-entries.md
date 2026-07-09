---
title: Remove concluded herd state entries so a re-queued issue can dispatch again
priority: high
labels: [herd]
blocked_by: []
---

`reconcileState` flags entries (`pr-concluded`, `dead`) but never deletes them,
and `dispatchOne` skips any issue present in the state file. The supervisor's
own escalation tells the operator to "re-queue the issue if its work is
unfinished" — but a re-queued issue is skipped forever because its stale entry
still sits in `.ratchet/herd-state.json`. The re-work path the escalation
promises does not exist, and the state file grows unbounded (one entry per
issue ever dispatched).

## Acceptance criteria
- [ ] An entry whose tracked PR is merged or closed is removed from the state file after its reconciliation escalation is written
- [ ] An issue whose worker died, whose entry was reconciled away, and which returns to `state:ready` is dispatched again on a later poll instead of being skipped
- [ ] An entry with a live worker pid or an open PR is never removed
- [ ] The poll summary line reports how many entries were pruned this pass
- [ ] Every criterion above has exactly one test named after it
