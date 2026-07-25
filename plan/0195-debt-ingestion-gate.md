---
title: Deferred-debt markers and PR deferrals must appear as plan files — automated scan gates the planning PR
priority: high
labels: [scripts, planning]
blocked_by: []
---

Disclosure is honest but nothing consumes it: 15 `ponytail:` markers persisted
in source the whole month, and "deferred scope" declarations in merged PR
bodies never became plan files. Debt ingestion becomes a planning obligation: a
script scans source markers and merged PR bodies for deferrals, and the
planning PR fails while any deferral has no covering plan file.

## Acceptance criteria
- [ ] A script scans the tree for `ponytail:` markers and merged PR bodies for deferred-scope declarations, and exits non-zero listing every deferral not covered by a plan file (active or `plan/done/`), each with its source location (`file:line` for markers, PR number for body declarations)
- [ ] A deferral covered by a plan file passes the scan; the covering mechanism (marker or PR body referencing the plan slug) is documented in `plan/README.md`
- [ ] The scan runs as a required check on the planning PR; the PR fails with the readable deferral list when unplanned debt exists, and passes once every listed deferral has a covering plan file
- [ ] The scan exits zero on a tree with no markers and no deferred-scope declarations (regression)
- [ ] The scan's failure output tells the author exactly what to do: add a plan file per listed deferral or reference an existing slug

## Notes
The 15 currently-outstanding markers become the gate's first work queue: the
first planning batch after this lands must plan or explicitly retire each.
