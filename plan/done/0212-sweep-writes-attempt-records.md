---
title: Stale-claim sweep records the abandoned attempt in the ledger
priority: medium
labels: [scripts]
blocked_by: [0211-attempt-record-on-requeue]
estimated_lines: 140
---

`sweep-stale-claims.mjs` is the other place an attempt dies: a claim with no
commits goes stale, an in-review issue loses its PR, changes-requested work
times out. The sweep requeues the issue with a prose comment, but that comment
is not an attempt record (0211's format), so abandonment — the most common way
an attempt ends without a PR — never lands in the ledger, and the next claimant
sees a clean-looking issue that has already burned one or more agents.

This plan makes every sweep requeue write the same structured attempt record
the agent-initiated requeue writes, with the sweep's classification as the
reason source.

## Acceptance criteria
- [ ] Each sweep decision that returns an issue to the queue posts an attempt record whose reason names the sweep classification (stale zero-commit claim, in-review without a live PR, changes-requested timeout) — proven by one test per classification parsing the record out of the captured comment
- [ ] Records written by the sweep and records written by `ratchet-requeue.mjs` are read back by the one shared parser as a single ordered ledger — proven by a test interleaving both kinds on one issue and asserting the combined ordered list
- [ ] Attempt numbering stays monotonic across sources: a sweep record on an issue with two prior requeue records is numbered 3 — proven by a test with that exact history
- [ ] A sweep decision that does not requeue (fresh work, merged-PR-blocked cleanup) writes no attempt record — proven by a test asserting no record comment is posted for those decisions
- [ ] A failed record post never blocks the sweep: the label transition still completes and the failure is visible in the sweep's log output naming the issue — proven by a test whose fake API rejects the comment call

## Non-functional
- No new workflow and no schedule change: the record rides the requeue path the
  sweep already executes, inside the existing `sweep-stale-claims` run.
