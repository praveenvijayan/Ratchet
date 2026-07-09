---
title: Surface plan-sync validation failures and close the labels side door
priority: medium
blocked_by: []
---

Three hardening items in the compiler. An invalid-frontmatter skip exits 0, so
a typo'd plan silently never becomes an issue and CI stays green — the original
"nonstandard label" symptom traded for a "silently dropped plan" one. The
`labels:` frontmatter is appended verbatim, so `labels: [priority:P1]` or
`labels: [state:ready]` recreates exactly the corruption priority validation
was built to stop. And the cycle gate only sees edges among files present in
the current sync, so a cycle assembled across syncs (one side resolved through
an issue marker) lands silently as a permanent deadlock.

## Acceptance criteria
- [ ] A sync that skipped any plan file for invalid frontmatter finishes as a visible failure, not a green run
- [ ] `labels:` entries beginning `state:` or `priority:` are never applied to the issue and produce a warning naming the file
- [ ] A `blocked_by` cycle whose edges span live files and marker-resolved issues is detected and reported loudly
