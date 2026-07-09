---
title: Validate plan-file frontmatter in plan-sync
priority: medium
blocked_by: []
---

`plan-sync` doesn't validate `priority` against `high|medium|low` — the
compiler's own regression test uses `P1`/`P2` and passes. A typo silently
creates a nonstandard label that sorts as lowest priority, corrupting the
queue's triage order with no warning.

## Acceptance criteria
- [ ] A plan file whose `priority` is not `high`, `medium`, or `low` is skipped with a loud warning naming the file and the invalid value
- [ ] A plan file missing `blocked_by` gets a warning naming the file (the field is documented as required), and is treated as having no blockers
- [ ] Unknown frontmatter keys produce a warning but do not block the sync
- [ ] The regression test's fixtures use valid priorities and cover the invalid-priority rejection path
