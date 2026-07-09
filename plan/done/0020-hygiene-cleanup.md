---
title: Hygiene pass — README duplication, stale model id, action pinning, PR template
priority: low
blocked_by: []
---

Small items that individually don't matter but collectively read as drift in a
framework that sells discipline: the README layout block has duplicated lines,
`ratchet-run` hard-codes a stale model id, actions are pinned to mutable tags,
and there is no PR template guiding the human review.

## Acceptance criteria
- [ ] The README layout section lists each file exactly once
- [ ] `ratchet-run.yml` uses a current model id and documents it as user-configurable
- [ ] All workflow actions are pinned to full commit SHAs (with the version as a comment)
- [ ] A PR template exists with a gates-results section matching what AGENTS.md step 5 requires in the PR body
- [ ] The worked example `plan/0001-email-login.md` no longer compiles into a real issue on this repo's first sync (relocate or exclude it while keeping a worked example in the docs)
