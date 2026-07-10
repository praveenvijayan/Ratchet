---
title: Worker rows show issue titles, not bare numbers
priority: low
labels: [herd]
blocked_by: []
---

Rows identify work only by issue number; the operator must cross-reference
GitHub to know what #150 is. Show the issue title next to the number.

## Acceptance criteria
- [ ] Each worker row shows the issue title alongside its number, linked to the issue
- [ ] Titles are cached so the dashboard does not query GitHub on every render or poll
- [ ] A title that cannot be fetched leaves the row rendering with the bare number and a placeholder, never blocking or erroring the row
- [ ] Every criterion above has exactly one test named after it
