---
title: Dashboard shows claim age only for live workers, last activity for the rest
priority: medium
labels: [herd]
blocked_by: []
---

The dashboard computes claim age from the latest dispatch/resume event for
every row, regardless of pid or status, and renders it red against
`claimTimeoutSeconds`. A row whose worker died hours ago shows `926m29s /
300s` in alarm red — a meaningless number, since the claim timeout only
applies pre-claim on a live worker. Dead and concluded rows drown the one row
where the timer actually matters.

## Acceptance criteria
- [ ] A row with a live worker pid in an active (non-terminal) status shows its claim age against the claim timeout, with the overdue highlight only when age exceeds the timeout
- [ ] A row in a terminal or escalated status, or with no live pid, shows a "last activity" age with no timeout denominator and no overdue highlight
- [ ] A row with no dispatch or resume event at all shows a placeholder, never a blank, `NaN`, or a negative age
- [ ] Every criterion above has exactly one test named after it
