---
title: Fix archive-closed-plans duplicate-marker and overwrite hazards
priority: medium
blocked_by: []
---

Two defects in `archive-closed-plans.mjs`. When the same `plan-id` marker
appears on more than one issue, the oldest-listed issue's state wins — so a
closed ancestor can archive the plan of a still-open issue. And the move uses
`rename`, which silently overwrites an existing file in `plan/done/`, despite
the inline comment claiming a clash errors: "frozen history" can be replaced
without a trace.

## Acceptance criteria
- [ ] A slug whose marker appears on both a closed and an open issue is not archived
- [ ] Archiving a file whose name already exists in `plan/done/` fails with a clear message naming both paths and overwrites nothing
