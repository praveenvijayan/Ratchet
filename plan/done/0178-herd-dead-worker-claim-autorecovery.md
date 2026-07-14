---
title: Supervisor auto-recovers a claim ref left by its own dead worker
priority: medium
labels: [herd]
blocked_by: []
---

A worker that claims and then crashes leaves `agent/issue-<N>` on origin; the
issue is blocked (every future worker sees a foreign claim and 422s) until a
human deletes the ref and runs requeue — measured cost ~7 minutes plus manual
intervention per crash. The supervisor has everything needed to recover
deterministically: it spawned the worker, watched it create exactly this ref,
observed the exit, and knows no PR exists. This is a deliberate, narrow
extension of supervisor authority — deleting only a claim ref it watched its
own worker create — and must be reviewed as such, not smuggled in.

## Acceptance criteria
- [ ] When a supervisor-spawned worker dies after its observed claim and no PR exists on the claim ref, the supervisor deletes that `agent/issue-<N>` ref and requeues the issue (the label flip + comment `ratchet-requeue` performs), logging one recovery event
- [ ] The recovered issue is redispatchable in the same run and a scoped run (`--issues`) proceeds to completion without human intervention
- [ ] A claim ref the supervisor did not observe its own worker create is never deleted — it escalates exactly as today (0066)
- [ ] A dead worker whose claim ref has an open PR is never touched by recovery (the orphaned-PR adoption path applies)
- [ ] A gh failure during ref deletion or requeue produces a single escalation with the exact recovery commands and does not crash the supervisor or stall the rest of the run
- [ ] The supervisor-authority wording in AGENTS.md/DOCS.md names this one permitted deletion explicitly, and the existing docs gates pass
- [ ] Every criterion above has exactly one test named after it

## Notes
Evidence: measured herd run where `opencode-glm` died 10s post-claim and the
issue stayed blocked until manual `gh api DELETE` + requeue. The carve-out is
bounded janitor work over state the supervisor itself created; merge/approve/
close/label authority is otherwise unchanged.
