---
title: Stop treating every release 422 as a tag collision; target the default branch
priority: high
blocked_by: []
---

`release.mjs` hardcodes `target_commitish: "main"` and its collision handler
classifies *any* 422 from the release POST as "tag already exists — another run
beat us to it", exiting green. GitHub also returns 422 for an invalid
`target_commitish`, so on any consumer repo whose default branch is `master`/
`trunk`/`develop` the release lane silently never releases, forever, while
every run reports a benign no-op. The old behaviour at least failed loudly.

## Acceptance criteria
- [ ] A 422 that is not a tag collision fails the run with the API's actual error surfaced — never the "another run beat us to it" message
- [ ] Only a 422 whose response reports the tag name already exists is treated as a benign collision no-op
- [ ] The release targets the repository's default branch rather than a hardcoded `main`, and cutting a release on a `master`-default repo succeeds
