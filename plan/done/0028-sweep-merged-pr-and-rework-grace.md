---
title: Stop the sweep misreading merged PRs and racing rework
priority: medium
blocked_by: []
---

`decideInReview` turns solely on "no open PR from the agent branch". Two
misfires follow. A PR that was *merged* while its issue stayed open (missing
`Closes #N`, or merged into a non-default base) is requeued with the factually
wrong comment "closed or abandoned without merge" — inviting a second agent to
redo merged work. And when a reviewer closes a PR with comments (the AGENTS.md
step 6 rework channel), the very next sweep tick can yank the issue back to
`state:ready` before the original agent begins the prescribed same-branch
rework. Cosmetic sibling: a vanished branch takes the "Branch kept (has
commits)" comment path.

## Acceptance criteria
- [ ] An in-review issue whose agent PR was merged is never requeued with an "abandoned without merge" message; the sweep comment states what actually happened
- [ ] An in-review issue whose PR was closed with review comments is not requeued until a configurable grace window has elapsed
- [ ] A sweep comment about a vanished branch does not claim the branch was "kept (has commits)"
