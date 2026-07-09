---
title: Add an opt-in deploy gate to the release lane
priority: low
blocked_by: [0023-release-idempotent-versioning]
---

The release lane tags and publishes a changelog, then stops — there is no
deploy step, deploy gate, or environment story, which was the other half of
the original "ship ends at merge" gap. Keep it opt-in like the rest of the
lane: repos without a deploy target must be entirely unaffected.

## Acceptance criteria
- [ ] The release lane supports an opt-in post-tag deploy step gated on an explicit repo setting, documented in DOCS.md alongside the release lane
- [ ] A repo that has not opted in sees no deploy job and no new required configuration
- [ ] A failed deploy is a visible failed run that does not delete or mutate the published tag and release
