---
title: Auto-deploy the static site when site files change on main
priority: medium
labels: [release, site]
blocked_by: []
---

The Pages deploy workflow (`static.yml`) has only a `workflow_dispatch`
trigger. Merging the release version-bump PR updates `index.html` on `main`,
but the live site stays stale until someone remembers to dispatch the workflow
manually — visitors see an old version and an old pinned install command
(observed after v5.0.0: bump merged, site still advertising v4.6.0).

## Acceptance criteria
- [ ] A push to `main` that changes `index.html` or other site assets (`img/**`, `logo.svg`) triggers the Pages deploy workflow automatically
- [ ] A push to `main` that touches no site file does not trigger a deploy
- [ ] Manual `workflow_dispatch` still deploys, unchanged
- [ ] Every criterion above has exactly one test named after it
