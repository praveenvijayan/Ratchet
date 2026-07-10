---
title: Group dashboard rows by lifecycle — live first, terminal last
priority: medium
labels: [herd]
blocked_by: [0081-herd-ui-claim-age-live-only]
---

Rows are sorted by issue number, so dead `dispatch-failed` rows interleave with
live workers and the operator scans the whole table to find what is actually
running. Group rows by lifecycle: live workers on top, then awaiting review,
then escalated, then terminal.

## Acceptance criteria
- [ ] Rows render in labelled groups ordered live, awaiting-review, escalated, terminal, with issue-number order within each group
- [ ] A row moves between groups live when its status changes, without a page reload
- [ ] An empty group renders nothing — no empty header taking space
- [ ] A status that maps to no known group falls into a visible catch-all group, never disappearing from the table
- [ ] Every criterion above has exactly one test named after it
