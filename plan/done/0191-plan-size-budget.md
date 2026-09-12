---
title: Declare a size budget in plan frontmatter and reject plans estimating over 400 lines at sync
priority: medium
labels: [scripts, planning]
blocked_by: []
---

The PR size cap is checked only after code exists, which produces negotiation
and overrides instead of splits (#334/PR#380 shipped over-cap). The split
mechanism works when forced (#43, #273) — force it at plan time, before any
code is written. Plan files declare an estimate of hand-written changed lines
(excluding generated files); the sync refuses estimates over the cap so the
author must split the plan into smaller files instead.

## Acceptance criteria
- [ ] A plan file may declare `estimated_lines: <n>` in frontmatter; the sync accepts the key without an unknown-frontmatter-key warning
- [ ] A plan file declaring `estimated_lines` greater than 400 aborts the sync non-zero before mutating GitHub, logging the file and the value with the instruction to split the plan
- [ ] A plan file with a non-integer or negative `estimated_lines` aborts the sync the same way, naming the file and the invalid value
- [ ] A plan file without `estimated_lines` syncs as before but logs a warning naming the file (existing plans are grandfathered; new plans should declare it)
- [ ] `plan/README.md` documents the key: hand-written changed lines only, generated files excluded, over-400 means split before writing code
