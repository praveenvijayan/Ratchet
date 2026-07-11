---
title: Stale-claim detection distinguishes closed issues from blocked open ones
priority: medium
labels: [herd]
blocked_by: []
---

`findStaleClaims` never checks whether the issue is open. A leftover
`agent/issue-N` ref whose issue is already closed (PR merged, work done) is
pure garbage — nothing to re-queue — yet it produces the same "every future
worker refuses the issue" escalation and occupies a worker row via the
sentinel, exactly like a genuinely blocked open issue. #175 sat red on the
dashboard for hours after its issue closed.

## Acceptance criteria
- [ ] A stale ref whose issue is closed is escalated with a message saying the issue is closed and only the ref needs deleting — no re-queue instruction
- [ ] A stale ref whose issue is closed does not create a worker row in the state file
- [ ] A stale ref whose issue is still open keeps the existing escalation wording, including the re-queue instruction
- [ ] A transient failure while checking issue state never changes the escalation outcome on its own; the check is retried on the next poll
- [ ] Every criterion above has exactly one test named after it
