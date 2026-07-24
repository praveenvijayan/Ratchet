---
title: Issue label stays state:in-review for the whole herd review rework — flip to state:changes-requested at rework start
priority: medium
labels: [scripts, herd]
blocked_by: []
---

During a herd review rework the issue's board state is wrong for the entire
rework window. Observed live (digital-workforce issues #220/#221, PRs
#225/#226): a human submits Request Changes on two conflicted PRs, herd
correctly dispatches rework workers (dashboard shows REWORKING), but both
issues still read `state:in-review` on the board — a human reading the issue
list concludes the PRs are still awaiting their review when they have already
been rejected and are being reworked.

The window opens because every label author misses this case:

- The real-time `review-verdict` workflow is silently skipped by GitHub on
  conflicted PRs (`mergeable_state: dirty`) — exactly the PRs herd's review
  rework handles (0184 documented this and deliberately made herd's *dedup*
  label-free, leaving the flip itself unowned in herd mode).
- `review-verdict-sweep` reconciles only on a */30 cron, and its flip can land
  mid-rework or be undone moments later when the worker finishes.
- Herd itself never labels (invariant, kept).
- The rework worker is the natural author — AGENTS.md step 6 has the agent set
  `state:changes-requested` when it starts rework and flip back to
  `state:in-review` after pushing — but herd's `REVIEW_REWORK_PROMPT` and
  `REVIEW_CONFLICT_REWORK_PROMPT` (herd-review.mjs) carry only the second half:
  they direct the flip back to `state:in-review` and never direct the flip to
  `state:changes-requested` at the start. So in herd mode nothing flips the
  label when rework begins.

## Acceptance criteria
- [ ] A herd review rework directs the worker, as its first board action before any fix commits, to set the issue to `state:changes-requested` and remove `state:in-review`, so the board reflects the rejection while the rework runs
- [ ] The combined conflict+review rework directs the same start-of-rework flip
- [ ] Both reworks still direct the flip back to `state:in-review` after the worker pushes, unchanged
- [ ] The herd review stage itself still never writes labels, and its per-rejection dedup still keys on the review id, not the label
- [ ] Every criterion above has exactly one test named after it

## Notes
The prompts already encode AGENTS.md step 6's closing flip; this adds the
opening flip the same way, keeping herd's "detection + dispatch only, never
labels" invariant intact — the worker does the labeling, as in chat mode.
`review-verdict`/`review-verdict-sweep` stay the reconciler for chat-mode users
and for the dispatch-to-worker-start gap.
