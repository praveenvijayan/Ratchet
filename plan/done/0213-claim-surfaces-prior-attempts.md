---
title: Claiming an issue surfaces its prior failed attempts
priority: medium
labels: [scripts]
blocked_by: [0212-sweep-writes-attempt-records]
estimated_lines: 180
---

The ledger (0211, 0212) is only worth writing if the next claimant reads it.
Today `ratchet-start.mjs` claims an issue and tells the agent nothing about its
history, so an agent picking up a swept or requeued issue starts blind and can
repeat the exact approach that already failed. This plan closes the read side:
the claim output carries the prior attempts, and the kernel tells the agent to
act on them.

## Acceptance criteria
- [ ] On a successful claim or resume, the one-line JSON from `ratchet-start.mjs` includes a `priorAttempts` array — attempt number, timestamp, gate (when recorded), and reason for each prior record, oldest first — proven by a test claiming an issue that carries two records and asserting both appear in order
- [ ] An issue with no attempt records claims exactly as today with `priorAttempts` empty — proven by a test asserting the empty array and an otherwise unchanged output shape
- [ ] A failure to fetch the records never blocks the claim: the claim completes, `priorAttempts` is absent, and the JSON carries a warning field naming the fetch failure — proven by a test whose fake API rejects the comment read
- [ ] The `AGENTS.md` build step instructs the agent to read the surfaced prior attempts before implementing and to not repeat an approach a record says already failed — proven by the kernel regression suite asserting the instruction is present
- [ ] `DOCS.md` documents the attempt ledger: where records are written, who writes them, and how the claim surfaces them — proven by the docs inventory suite finding the section

## Test notes
- Cover the legacy-record path end to end: an issue whose only history is a
  pre-0211 prose requeue comment still yields one `priorAttempts` entry at
  claim time.

## Non-functional
- The claim's exit-code contract (0/2/3/4/1) and every existing JSON field are
  unchanged — additions only, so nothing that shells the script today breaks.
