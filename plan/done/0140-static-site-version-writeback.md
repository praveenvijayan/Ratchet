---
title: Static site version stays in sync with releases
priority: medium
labels: [release, docs]
blocked_by: []
---

The static site (`index.html`) hardcodes the framework version in several
places (currently `v4.1.0` in 7 spots while the repo is at 4.6.0). It is not
in `VERSION_LOCATIONS`, so the release bump PR never updates it and the
version-consistency gate never catches the drift — visitors see a stale
version and a stale install command.

## Acceptance criteria
- [ ] The release bump PR updates every version occurrence in `index.html` to the new version, alongside the existing four locations
- [ ] `version-consistency.mjs` fails with a clear per-occurrence report when any version in `index.html` disagrees with `.ratchet-version`, and passes when they agree
- [ ] If `index.html` contains no recognizable version occurrence, the bump fails with a clear message naming the file and the expected pattern, never writing a partial bump
- [ ] Every criterion above has exactly one test named after it
