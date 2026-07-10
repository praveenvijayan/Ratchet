---
title: Ready-for-review rows show PR CI status
priority: low
labels: [herd]
blocked_by: []
---

A ready-for-review row links the PR but says nothing about CI. The operator
opens each PR just to learn whether checks passed. Surface pass/fail/pending
on the row.

## Acceptance criteria
- [ ] A row with an open PR shows its combined checks status: passing, failing, or pending
- [ ] The status refreshes periodically without a page reload; the last-fetched time is visible
- [ ] A checks query failure shows an "unknown" state on the row, never a stale "passing" presented as current or a broken row
- [ ] Every criterion above has exactly one test named after it
