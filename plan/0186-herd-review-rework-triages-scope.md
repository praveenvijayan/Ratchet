---
title: Herd's review rework triages feedback — in-scope fixes land in the PR, new features route to the plan protocol
priority: high
labels: [scripts, herd]
blocked_by: [0185-herd-review-rework-resolves-conflict]
---

A Request Changes review is not always an in-scope fix. Reviewers also ask for
work the issue never scoped — a new feature, a behaviour outside the issue's
acceptance criteria. herd-review's `REVIEW_REWORK_PROMPT` today tells the worker
to "address each point" unconditionally, so an out-of-scope request gets built
straight into the PR, breaking the one-issue-one-PR scope rule (AGENTS.md), or
leaves the PR stuck because the "fix" is really unplanned work. The worker must
read every review comment, classify each, and act by type: an in-scope change or
fix is committed on the PR's existing branch (and any merge conflict resolved
there too, per 0185) so the fix and the conflict land in the same PR; work that
is a new feature or otherwise outside the issue's scope is **not** implemented in
this PR — it is routed through the ratchet-plan protocol (a `plan/*.md` on the
planning PR) so it becomes its own reviewed issue.

## Acceptance criteria
- [ ] The review-rework instruction directs the worker to read every review comment and classify each as an in-scope fix or out-of-scope/new-feature work before acting
- [ ] For in-scope feedback the instruction directs the worker to address it with commits on the PR's existing branch — no new PR, no plan file — alongside the conflict resolution from 0185 so both land in the same PR
- [ ] For out-of-scope or new-feature feedback the instruction directs the worker NOT to implement it in this PR, but to file it through the ratchet-plan protocol (plan file on the planning PR) and reply on the review pointing to that plan
- [ ] Every criterion above has exactly one test named after it

## Notes
This extends the same `REVIEW_REWORK_PROMPT` that 0185 makes conflict-aware, so
the two order behind each other on the same file. Scope authority is AGENTS.md's:
an agent never widens an issue's scope from a review comment — it either does the
scoped fix or plans the new work. Herd still never merges, approves, or labels;
the worker pushes the in-scope fix and flips the label back, and the plan file it
files for out-of-scope work follows the normal human-merge planning path.
