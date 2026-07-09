---
title: Extend the plan format for non-functional requirements and extra test guidance
priority: medium
blocked_by: []
---

"Exactly one test per criterion" is a good stopping condition but a weak
quality floor: edge cases, property/regression tests, and integration coverage
are explicitly discouraged, and non-functional requirements (performance,
accessibility, load, migrations) have no home in the plan format. Production
defects live precisely in the cases the criteria didn't enumerate.

## Acceptance criteria
- [ ] `plan/README.md` documents optional `## Non-functional` and `## Test notes` sections and how a building agent must treat each
- [ ] AGENTS.md's build step permits tests demanded by these sections in addition to criteria-mapped tests, without counting them as padding
- [ ] A plan file without the new sections compiles and behaves exactly as before (regression)
