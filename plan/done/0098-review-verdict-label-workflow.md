---
title: GitHub workflow flips the issue to state:changes-requested on a Request Changes review
priority: high
labels: []
blocked_by: []
---

Nothing GitHub-side reacts to a review verdict: no workflow triggers on
`pull_request_review`, so when a human submits Request Changes the issue stays
`state:in-review` until some agent happens to pick up the rework. In the normal
(chat) flow that means the board lies indefinitely — observed on PR #188 /
issue #165. Label truth should be system-closed like merge (`ratchet-run`) and
unblocking (`unblock-dependents`): a small workflow on review submission flips
the label, for both chat and herd flows, so no agent-side copy of this logic is
ever needed.

## Acceptance criteria
- [ ] A CHANGES_REQUESTED review submitted on an open PR whose branch is `agent/issue-<N>` (or whose body says `Closes #<N>`) moves issue N from `state:in-review` to `state:changes-requested`
- [ ] An APPROVED or COMMENTED review changes no labels
- [ ] A review on a PR that maps to no issue does nothing and the run succeeds, logging the skip
- [ ] A Request Changes review when the issue is already `state:changes-requested` leaves it unchanged and the run succeeds
- [ ] A label-update API failure fails the run visibly with a one-line error naming the issue — never a silent success
- [ ] Every criterion above has exactly one test named after it

## Notes
One-directional by design: the flip back to `state:in-review` after rework is
pushed stays with the agent (AGENTS.md step 6), which knows when its rework is
complete. This workflow is the single owner of the review-time flip —
0097-herd-review-verdict-rework's supervisor and chat agents rely on it rather
than duplicating it.
