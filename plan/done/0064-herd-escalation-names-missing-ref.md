---
title: Name the missing claim ref in the dispatch-timeout escalation
priority: low
labels: [herd]
blocked_by: []
---

When a worker misses the claim window, the escalation says only "worker did
not claim the issue within Ns". Since 0061 the claim signal is the server-side
branch ref `agent/issue-<N>`, but the message never says so — an operator
reading `.ratchet/escalations.md` cannot tell what "claim" was being waited on
or what to look for on origin.

## Acceptance criteria
- [ ] The dispatch-timeout escalation's `what` names the exact missing signal — the `agent/issue-<N>` ref on origin — alongside the timeout in seconds and the killed pid
- [ ] Every criterion above has exactly one test named after it
