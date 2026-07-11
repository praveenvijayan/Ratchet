---
title: GitHub-side enforcement — exactly one state:* label per issue
priority: high
labels: []
blocked_by: []
---

Issue #181 carried `state:ready` and `state:in-review` together, and nothing
enforces that an issue has at most one `state:*` label, so any agent slip
becomes permanent. The damage is not cosmetic: the pick step selects by
`state:ready`, so an issue under review looks pickable and can be dispatched a
second time. Enforce the invariant GitHub-side, labeled-event driven — the same
closed-loop pattern as unblock-dependents — so agent-side discipline is never
load-bearing.

## Acceptance criteria
- [ ] When any `state:*` label is added to an issue that already has a different one, the system removes the older state label so exactly one remains, without human action
- [ ] The enforcement treats the newest label as the truth and never removes the only state label an issue has
- [ ] Non-state labels (`priority:*`, `herd`, others) are never touched by the enforcement
- [ ] An enforcement API failure fails its run visibly naming the issue, never silently leaving the dual state
- [ ] Every criterion above has exactly one test named after it

## Notes
Split B of the original issue-#207 scope (see its scope-split comment): the
instruction-wording half is 0101-state-instructions-remove-previous-label. A
built, gate-green implementation of this piece exists as `issue-207-built.patch`
per that comment — reuse, don't rebuild.
