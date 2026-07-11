---
title: Let GATES.md carry a second table without aborting the gate run
priority: low
blocked_by: []
---

`run-gates.mjs` locks the expected column count from the first `|` line in the
whole file. A hand-authored notes or troubleshooting table below the gates
table — GATES.md's own header says "edit it freely" — aborts the entire run
with zero gates executed and a misdiagnosis ("an unescaped pipe in a command").

## Acceptance criteria
- [ ] A GATES.md containing an additional unrelated table runs the gates table normally
- [ ] A malformed row inside the gates table itself still fails the run loudly, naming the row
