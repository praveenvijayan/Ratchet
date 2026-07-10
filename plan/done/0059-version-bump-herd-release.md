---
title: Bump the framework version to reflect the shipped herd supervisor series
priority: medium
labels: [herd]
blocked_by: [0058-skill-cross-agent-parity]
---

The herd supervisor (config, survey, dispatch, monitor, verify, skill, docs, and
the cross-agent parity guard) is a new feature set, but `.ratchet-version` still
reads the pre-herd `3.3.6`. On the framework repo `.ratchet-version` is
hand-maintained — `release.mjs` only reads it to seed the first release and
`ratchet-update.sh` copies it downstream — so consumers running `/ratchet-update`
and the release seeder both advertise a stale version until it is bumped.

## Acceptance criteria
- [ ] `.ratchet-version` contains a valid `MAJOR.MINOR.PATCH` semver string, strictly greater than `3.3.6`, bumped in the minor position (a new feature set, not a patch)
- [ ] `node scripts/release.test.mjs` stays green — the first-release seeder still parses `.ratchet-version` after the bump, so a malformed value can never ship
- [ ] `DOCS.md`'s version reference (or its changelog/what's-shipped note) names the herd supervisor under the new version, so `/ratchet-update` consumers can see what the bump delivers

## Notes
Version writeback to `.ratchet-version` is not automated on the framework repo
(release manages git tags, not this file), so the bump is a deliberate edit —
not a regression in the release lane.
