---
title: Herd's review rework resolves a conflicting base so the reworked PR becomes mergeable
priority: high
labels: [scripts, herd]
blocked_by: [0184-herd-review-dedup-decouple-from-label]
---

`herd-verify.mjs` dispatches a conflict rework ("merge origin/main, resolve
every conflict, …") only for entries at `awaiting-verification`. Once a PR
passes verify it becomes `ready-for-review`, and from then on only
`herd-review.mjs` revisits it. But a PR that was mergeable at verify time can
go conflicting later when `main` advances under it — and when that same PR then
gets a Request Changes review, herd-review dispatches its `REVIEW_REWORK_PROMPT`,
which addresses the review feedback and pushes but never mentions the base
conflict. The worker pushes its review fixes onto a branch still behind `main`,
the PR stays `mergeable_state: dirty`, and no herd stage ever sends it back
through conflict resolution — it can never merge. Observed on `mdtohtml` PR #20
/ issue #16: changes-requested **and** dirty at once, so the next herd cycle's
review rework would leave the conflict unresolved and the PR unmergeable.

## Acceptance criteria
- [ ] When herd dispatches a rework for a changes-requested PR that is conflicting (mergeable CONFLICTING or merge-state DIRTY), the rework instruction directs the worker to merge origin/main and resolve every conflict in addition to addressing the review feedback, then push — a successful rework leaves the PR mergeable, not dirty
- [ ] When the same PR is not conflicting, the rework instruction is the review-only prompt, unchanged from today
- [ ] The conflict-and-review rework counts against the same reworkCap as other reworks; at the cap it escalates exactly once, naming that the PR is both conflicting and changes-requested
- [ ] Every criterion above has exactly one test named after it

## Notes
Diagnosed cause: conflict detection and its rework prompt live only in
herd-verify's `awaiting-verification` branch; herd-review has no conflict
awareness, so a PR that turns dirty after promotion to `ready-for-review` never
returns to conflict resolution. herd-review already lists open PRs — extend that
read to carry mergeability (`mergeable` / `mergeStateStatus`) alongside
`reviewDecision`, and when a dispatched rework's PR is conflicting, render a
prompt that combines the conflict-resolution and review-feedback instructions.
Reuse herd-verify's conflict wording rather than inventing a second phrasing.
Herd still never merges or labels; the worker pushes and flips the label back.
