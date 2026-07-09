---
title: Add an opt-in release lane (versioning, changelog, tagging) after merge
priority: medium
blocked_by: []
---

The loop ends at merge: no versioning, changelog, release tagging, or deploy
gate exists. Ratchet currently builds; it doesn't ship. An opt-in release lane
makes "shipped" a first-class stage without forcing it on every project.

## Acceptance criteria
- [ ] An opt-in release workflow (off by default, gated on a repo variable like the existing `RATCHET_AUTO` pattern) tags a version and generates a changelog from merged PR titles on demand
- [ ] With the lane disabled, no release automation runs and nothing fails (safe default)
- [ ] DOCS.md and the loop diagram document the release step as a post-merge stage
- [ ] A release run with no merges since the last tag exits cleanly with a "nothing to release" message, not an error
