---
title: Bound herd worker log growth with a retention knob
priority: low
labels: [herd]
blocked_by: []
---

Worker logs in `logDir` are never pruned: every dispatch appends a log,
resumes append to the same file, and stream-json adapters multiply the size
10–100x. Long-running herds accumulate unbounded log storage with no knob and
no cleanup.

## Acceptance criteria
- [ ] `logRetentionDays` is an optional `.ratchet/herd.json` knob with a sensible default; a non-positive or non-integer value exits non-zero with a one-line error naming the file and field
- [ ] Log files older than the retention window whose issue has no live worker in the state file are deleted during the poll
- [ ] A log referenced by a live worker's state entry is never deleted regardless of age
- [ ] The poll summary line reports how many log files were pruned this pass
- [ ] Every criterion above has exactly one test named after it
