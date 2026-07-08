---
title: Archive plan files whose issues are closed
priority: low
blocked_by: []
---

Plan files stay in `plan/` forever after their issues close, and every sync
re-scans them. Noise grows linearly with project age — in year two of a
multi-year project the directory is mostly history, inviting slug confusion.
The sync already resolves removed files through issue markers, so archiving is
safe by design.

## Acceptance criteria
- [ ] A maintenance path (`/ratchet-memory` or a dedicated sweep) moves plan files whose issues are closed into `plan/done/`, via a reviewable commit
- [ ] `plan-sync` ignores `plan/done/` entirely
- [ ] A `blocked_by` reference to an archived slug still resolves through the closed issue's `plan-id` marker (covered by the compiler regression test)
