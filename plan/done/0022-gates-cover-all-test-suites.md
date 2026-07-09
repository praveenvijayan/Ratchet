---
title: Run every scripts test suite through the GATES.md table
priority: medium
blocked_by: []
---

GATES.md lists six test gates but `scripts/` holds twelve test files. Because
both local verification and the `pr-gates` CI check execute exactly the
GATES.md table via `run-gates.mjs`, the other six suites (`criteria`,
`pr-size-check`, `run-gates`, `sweep-lease`, `verify-issue-body`,
`ratchet-metrics`) run nowhere — a regression in the enforcement layer's own
logic would merge green.

## Acceptance criteria
- [ ] The GATES.md test gates execute every `scripts/*.test.mjs` file
- [ ] A test fails when a `scripts/*.test.mjs` file exists that no GATES.md row runs, so new suites can't be forgotten
- [ ] The `run-gates` summary names each test gate it ran, so the reviewer can see coverage at a glance
