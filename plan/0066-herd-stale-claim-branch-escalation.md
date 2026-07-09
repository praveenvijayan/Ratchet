---
title: Detect and escalate stale agent/issue-N claim branches that block re-work
priority: medium
labels: [herd]
blocked_by: []
---

Per AGENTS.md §2 the branch ref `agent/issue-<N>` *is* the claim. A worker
killed at the claim timeout can still have created the ref (it raced the
kill), and a dead worker always leaves its ref behind. Nothing looks for these:
the ref keeps the issue claimed forever, every future worker sees a foreign
claim and refuses, and the operator gets no signal about why the issue never
moves. The supervisor never deletes branches (stuck claims escalate, not
improvise), so the fix is detection plus an actionable escalation.

## Acceptance criteria
- [ ] A claim ref `agent/issue-<N>` on origin whose issue has no live worker in the state file and no open PR is escalated as a stale claim, naming the ref and the exact command that deletes it
- [ ] The dispatch-timeout escalation re-checks the ref after the kill and, when the killed worker created it anyway, says so and includes the same deletion command
- [ ] A ref with a live worker or an open PR is never flagged
- [ ] A transient gh failure while checking refs never produces a stale-claim escalation on its own
- [ ] Each stale ref is escalated once, not re-escalated every poll
- [ ] Every criterion above has exactly one test named after it
