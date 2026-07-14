---
title: Deduplicate escalations at the source — one entry per issue and reason-class
priority: medium
labels: [herd]
blocked_by: []
---

A persisting cause re-escalates every poll tick: in a measured run one stale
claim ref produced 11+ identical `herd-escalations.md` entries (one per 65s
tick) until a human deleted the ref. The dashboard dedupes at render time
(0082) and the stale-claim detector suppresses its own repeats (0066), but
other escalation writers still append every tick, so the file itself drowns a
genuinely new escalation in noise. Deduplicate where entries are written, for
every reason class.

## Acceptance criteria
- [ ] An escalation whose issue and reason-class match an existing unresolved entry updates that entry's occurrence count and last-seen timestamp instead of appending a new block
- [ ] A new reason-class for the same issue, or the same reason-class for a different issue, still appends a new entry
- [ ] Every escalation call path (survey, dispatch, monitor, reconcile, review) writes through the deduplicating writer — no writer can bypass it
- [ ] A simulated run where one cause persists across many polls ends with exactly one entry for it, regardless of run length
- [ ] The dashboard's escalation rendering and resolution logic (0082) still parses the updated entries, showing the occurrence count and latest timestamp
- [ ] A malformed or unparseable existing escalations file never crashes the writer: the new entry is appended and a warning event is logged
- [ ] Every criterion above has exactly one test named after it

## Notes
The append-only file stays the source of record; dedup mutates only the
matching entry's count/last-seen fields, never rewrites history for other
entries.
