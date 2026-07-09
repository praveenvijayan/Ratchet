---
title: Scope the readiness check to the Acceptance criteria section
priority: low
blocked_by: []
---

`hasAcceptanceCriteria` requires an `## Acceptance criteria` heading AND a
`- [ ]` checkbox — but the checkbox may be anywhere in the body. A plan with an
empty criteria section plus a stray checkbox under `## Test notes` wrongly
compiles as `state:ready`. The optional sections added for plan-format quality
are exactly what makes this reachable, and plan/README.md already promises the
check looks for "its" checkboxes.

## Acceptance criteria
- [ ] A body whose only `- [ ]` items sit outside the `## Acceptance criteria` section classifies as draft
- [ ] A body with at least one `- [ ]` inside the `## Acceptance criteria` section still classifies as ready
