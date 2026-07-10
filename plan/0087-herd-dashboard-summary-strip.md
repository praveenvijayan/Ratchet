---
title: One-glance summary strip on the herd dashboard
priority: medium
labels: [herd]
blocked_by: [0082-herd-escalation-resolution]
---

Fleet health currently requires reading the whole page. A summary strip at the
top — ready-queue depth, live workers, PRs awaiting review, unresolved
escalations — answers "is the herd fine?" in one glance.

## Acceptance criteria
- [ ] The strip shows the count of `state:ready` issues in the queue, live workers (alive pid, active status), open PRs awaiting review, and unresolved escalations
- [ ] The counts update live as state and events change, without a page reload
- [ ] A count whose source is unavailable (e.g. the queue query fails) shows a placeholder with a tooltip naming the failure, never a zero that reads as "all clear"
- [ ] Every criterion above has exactly one test named after it
