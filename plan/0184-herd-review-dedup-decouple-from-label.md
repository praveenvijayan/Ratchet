---
title: Herd picks a changes-requested rework on a conflicted PR without waiting for the label flip
priority: high
labels: [scripts, herd]
blocked_by: []
---

`herd-review.mjs` gates a rework dispatch on two signals, both required: the
PR's `reviewDecision` is `CHANGES_REQUESTED` **and** the issue still carries the
`state:changes-requested` label (classifyReview, the `!changesRequested` noop).
The label is the per-rejection dedup. But that label is set by the real-time
`review-verdict` workflow, which GitHub **silently skips on conflicted PRs**
(`mergeable_state: dirty`) — the exact case the `review-verdict-sweep` (`*/30`
cron) exists to reconcile. So on a dirty PR a Request Changes review lands,
`reviewDecision` reads `CHANGES_REQUESTED` (available even while dirty), the
label stays `state:in-review` for up to 30 minutes, and herd-review returns
`noop` the whole window — it never dispatches the rework it can plainly see.
Herd's dedup is coupled to a signal known-unreliable for precisely the PRs that
most need rework. Observed live on `mdtohtml` PR #20 / issue #16: the flip
required three manual `review-verdict-sweep` dispatches because each rejection
landed while the PR was dirty and just missed the cron window.

## Acceptance criteria
- [ ] A tracked ready-for-review PR whose latest review is CHANGES_REQUESTED gets exactly one rework dispatched even when the PR is conflicted and its issue label still reads state:in-review (the real-time review-verdict flip was skipped)
- [ ] After the rework worker pushes its fix, the same rejection is not re-dispatched on later polls — the dedup holds without depending on the label having flipped back to state:in-review
- [ ] A genuinely new Request Changes review submitted after a rework dispatches one more rework up to reworkCap, then escalates exactly once at the cap
- [ ] An APPROVED, COMMENTED, or absent review decision dispatches nothing, unchanged
- [ ] Every criterion above has exactly one test named after it

## Notes
Diagnosed cause: `classifyReview` uses the `state:changes-requested` label as
its "this is a fresh, still-outstanding rejection" dedup, but the label's
real-time author (`review-verdict`) does not fire on dirty PRs. The header
comment calls the label "authoritative"; it is not for conflicted PRs.

Suggested direction (implementer chooses the mechanism): key the dedup on the
latest review's own identity — its node id or `submitted_at` — tracked in herd
state per entry, instead of the label. A rework is fresh iff the latest
CHANGES_REQUESTED review is newer than the one herd last acted on; after the
worker pushes, `reviewDecision` is unchanged but the review identity is too, so
no re-dispatch. Fetch the latest review only for the small set of tracked,
ready-for-review PRs already reading CHANGES_REQUESTED, to keep the extra API
cost bounded. Herd still never labels — the state:in-review flip stays the
worker's job (AGENTS.md step 6); this only removes herd's *read* dependency on
the label. The `review-verdict` workflow and its sweep stay as the board's
own reconciler for chat-mode users; this change makes herd self-sufficient.
