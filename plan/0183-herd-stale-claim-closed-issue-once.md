---
title: Stale claim ref on a closed issue is escalated once, not every poll
priority: low
labels: [scripts, herd]
blocked_by: []
---

The stale-claim detector promises "each stale ref is escalated once" via a
`stale-claim` sentinel state entry — but only the open-issue branch writes the
sentinel. A stale claim ref whose issue is already closed re-enters detection
every poll: it re-queries the issue state over the API, re-submits its
escalation (now absorbed by the deduplicating writer as an occurrence bump),
and re-counts in the per-poll `escalated N stale claim refs` summary line.
Observed in a live run: three closed-issue stale refs logged `escalated 3
stale claim refs` on every tick until a human deleted the refs. The file no
longer grows (0177), but the summary line is misleading — a steady non-zero
count reads as new trouble — and each ref costs one issue-state API call per
poll for as long as it lingers.

## Acceptance criteria
- [ ] A stale claim ref whose issue is closed is escalated exactly once: later polls with the ref still present write no escalation entry, bump no occurrence count, and make no issue-state API call for it
- [ ] The per-poll summary counts only stale refs newly escalated this pass; a ref escalated on an earlier poll no longer appears in the count
- [ ] Once the stale ref is deleted from origin, its suppression is cleared, so a genuine recurrence of the same ref escalates again
- [ ] Every criterion above has exactly one test named after it

## Notes
Diagnosed cause: in the stale-claim loop the open-issue branch writes the
`STALE_CLAIM_STATUS` sentinel into the state file, the closed-issue `else`
branch does not — so the "already escalated once" guard at the top of the loop
never trips for closed issues. The existing sentinel-clearing rule (entry
deleted when the ref disappears) already covers the recurrence criterion for
open issues.
