---
title: Desktop notification on new escalation
priority: low
labels: [herd]
blocked_by: [0082-herd-escalation-resolution]
---

The operator must keep the dashboard tab open to notice a new escalation.
Fire a native desktop notification (macOS `osascript`; no-op with a logged
hint on platforms without a notifier) when a new unresolved escalation
appears.

## Acceptance criteria
- [ ] A new unresolved escalation triggers exactly one desktop notification naming the issue and reason
- [ ] Duplicate occurrences of an already-notified escalation (same issue and reason) do not re-notify
- [ ] On a platform without a supported notifier, escalations still record normally and a one-line hint is logged once, never an error per escalation
- [ ] A failure invoking the notifier is logged and never affects the poll or the escalation record
- [ ] Every criterion above has exactly one test named after it
