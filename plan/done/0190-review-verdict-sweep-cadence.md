---
title: Tighten the review-verdict sweep cadence so a missed flip is reconciled within minutes, not half an hour
priority: medium
labels: [scripts, herd]
blocked_by: []
---

When GitHub silently skips the real-time `review-verdict` run (conflicted PRs,
`mergeable_state: dirty` — the exact PRs that most need rework), the only
reconciler for the board is `review-verdict-sweep`, and it runs on a
`*/30 * * * *` cron. That is a up-to-30-minute window in which a rejected issue
still reads `state:in-review` — observed live on digital-workforce issues
#220/#221, where two conflicted PRs drew Request Changes reviews and the board
misled for the whole window. 0189 closes the window for herd mode (the rework
worker flips the label at rework start), but chat-mode users and any repo not
running herd still wait for the sweep. GitHub's cron is best-effort — runs are
often minutes late and can be dropped under load — so the floor is set by
cadence: a tighter schedule directly shrinks the worst-case lie on the board.

## Acceptance criteria
- [ ] The `review-verdict-sweep` workflow runs on a 5-minute cron instead of every 30 minutes
- [ ] The sweep's documented cadence (DOCS.md workflow table) matches the new schedule
- [ ] A sweep pass that finds nothing to flip stays a cheap no-op: no label writes, one log line per skipped PR, unchanged decision logic
- [ ] Every criterion above has exactly one test named after it

## Notes
The sweep is already idempotent and re-reads before writing, so a faster
cadence adds API reads but no new race: a concurrent worker flip is detected
and skipped (`decideReconcile` + the write-time re-read in
`review-verdict-sweep.mjs`). Only the trigger cadence and its docs move; the
decision core stays untouched. Complements 0189-herd-rework-flips-changes-requested
— that covers herd mode in real time, this shrinks the reconciliation floor
everywhere else.
