---
title: Make criteria.mjs the single authority for the plan-id marker
priority: medium
labels: [scripts, refactor]
blocked_by: [0153-migrate-gh-api-sync-scripts]
---

The `<!-- plan-id: <slug> -->` marker is parsed by two divergent regexes:
`criteria.mjs` tolerates whitespace variants while `archive-closed-plans.mjs`
requires exact spacing. A marker with unusual spacing is resolved by the sync
but silently skipped by the archive sweep — the plan file never archives.
Consolidate on the tolerant form in `criteria.mjs` and make every consumer
import it. Blocked by 0153-migrate-gh-api-sync-scripts because both issues
edit `archive-closed-plans.mjs`.

## Acceptance criteria
- [ ] `criteria.mjs` exports the marker constant/parsing used to read and write `<!-- plan-id: <slug> -->`, tolerating optional whitespace around `plan-id:` and the slug
- [ ] `archive-closed-plans.mjs` and `plan-sync.mjs` obtain the slug via the `criteria.mjs` export, and no other file under `scripts/` contains its own `plan-id` regex
- [ ] An issue body whose marker has extra internal whitespace is archived by `archive-closed-plans.mjs` exactly as a normally-spaced marker is
- [ ] Every criterion above has exactly one test named after it
