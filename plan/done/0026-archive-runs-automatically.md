---
title: Archive closed plans automatically, not by manual invocation
priority: low
blocked_by: [0025-archive-script-safety]
---

The archive mechanism shipped but has never run: `plan/` still holds ~19 files
for closed issues, and the only trigger is someone remembering to run
`node scripts/archive-closed-plans.mjs`. A hygiene mechanism that depends on
memory is the accumulation problem restated.

## Acceptance criteria
- [ ] Plan files of closed issues are archived on a recurring trigger (schedule or post-close), with no manual command required
- [ ] Archive moves land as a reviewable PR, never a direct push to `main`
- [ ] When nothing needs archiving, the trigger exits quietly without opening an empty PR
