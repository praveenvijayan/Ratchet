---
title: No plan ships a mock as the deliverable — a stub must link its repayment plan in the same batch
priority: medium
labels: [scripts, planning]
blocked_by: [0193-criteria-verifiability-rule, 0197-plan-risk-tier]
---

Screens-first plans (the #106–#114 era) shipped mocks as deliverables and
created the de-fake tax: later work paid to replace fakes that had already
"passed". A plan either delivers a working end-to-end path, or it explicitly
declares itself a stub and links the repayment plan file created in the same
planning PR. "Real implementation arrives later" without a plan file is
rejected at sync.

## Acceptance criteria
- [ ] A plan file may declare `stub: true` with `repaid_by: <slug>` in frontmatter; the sync accepts both keys without unknown-frontmatter-key warnings
- [ ] A plan declaring `stub: true` whose `repaid_by` is missing, or names a slug that resolves to no plan file and no issue, aborts the sync non-zero naming the file and the unresolved slug
- [ ] A stub plan's issue body names its repayment issue (`Repaid by #N`) so the debt is visible from GitHub
- [ ] `plan/README.md` documents the vertical-slice rule: deliver a working end-to-end path, or declare the stub and create its repayment plan in the same planning PR
- [ ] Plans without the new keys compile and sync exactly as before (regression)
