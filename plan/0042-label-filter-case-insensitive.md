---
title: Filter reserved label prefixes case-insensitively in plan-sync
priority: medium
blocked_by: []
---

The reserved-label filter drops frontmatter labels starting `state:` or
`priority:` — but only in exact lowercase. GitHub label names are
case-insensitive, so `labels: [State:blocked]` sails through the filter and
the API attaches the real `state:blocked` label to a `state:ready` issue,
recreating exactly the double-state corruption the filter exists to stop.

## Acceptance criteria
- [ ] Frontmatter labels matching a reserved prefix in any letter case are dropped with the warning naming the file
- [ ] Non-reserved labels keep their original case when applied
