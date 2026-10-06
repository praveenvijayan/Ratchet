---
title: Requeue writes a structured attempt record, not just prose
priority: medium
labels: [scripts]
blocked_by: []
estimated_lines: 160
---

When an agent hands an issue back — red gates, over-scope — `ratchet-requeue.mjs`
posts a prose comment with a `<!-- ratchet-requeue -->` marker. Prose is enough
for a human but invisible to the next agent: nothing distinguishes "attempt 3,
failed the `test: plan-sync` gate" from any other comment, so a fresh claimant
cannot machine-read what was already tried and repeat the same dead end. The
loop pays for the same failure twice.

This plan upgrades the requeue notice into an **attempt record**: the same
single comment, but its marker carries structured fields the tooling can parse
back — attempt number, the owner that failed, an optional gate name, and the
one-line reason. Humans still read the prose; scripts read the marker.

## Acceptance criteria
- [ ] `ratchet-requeue.mjs` accepts an optional `--gate "<name>"` argument and the posted comment's marker encodes attempt number, owner id (when `--owner` is given), gate, and reason as parseable fields — proven by a test that posts a requeue against a fake API and parses the fields back out of the captured comment body
- [ ] The attempt number is one greater than the count of existing attempt records on the issue, starting at 1 — proven by a test where an issue with two prior records gets a third record numbered 3
- [ ] A shared exported parser returns the ordered list of attempt records from an issue's comments, ignoring non-record comments — proven by a test feeding it a mixed comment stream (records, heartbeats, human prose) that returns only the records, oldest first
- [ ] A legacy `<!-- ratchet-requeue -->` comment without structured fields is still recognised as one attempt with its body as the reason, so history from before this change is not lost — proven by a test parsing a pre-existing legacy comment
- [ ] Invalid input never reaches the API: an empty `--gate` value exits 2 with usage to stderr and one JSON error line to stdout, like the existing argument errors — proven by a test invoking it with `--gate ""`
- [ ] The existing idempotency holds: re-running the same requeue does not post a second record — proven by a test re-running against an issue already carrying the identical record

## Test notes
- Exercise the parser against a comment whose marker fields contain the
  delimiter characters themselves (a reason with quotes or newlines), asserting
  round-trip fidelity — attacker- or accident-supplied text must not corrupt
  the record structure.

## Non-functional
- The record stays inside the one comment the requeue already posts — no new
  API call, no new comment per requeue, so the strict comment-first ordering
  and interrupted-run safety of the current script are unchanged.
