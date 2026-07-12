---
title: plan-sync slug resolution must survive marker syntax quoted in plan prose
priority: high
labels: [scripts, bug]
blocked_by: []
---

One plan file produced three issues (#345, #349, #356 — one per sync run).
Root cause, confirmed against the live issue bodies: the sync identifies an
issue's slug with a first-occurrence regex match, and the appended `plan-id`
HTML-comment marker is always the LAST thing in a rendered body. The 0154 plan
body quotes the marker syntax in its prose, so the first match captures the
quoted placeholder instead of the real slug, the slug never enters the dedup
map, and every sync run creates a fresh issue. This recurs on every plan merge
while such an issue is open — not a race, not pagination, not snapshot
staleness. Closing the surplus issues is a human action, not part of this
issue.

## Acceptance criteria
- [ ] `planSlug` in `criteria.mjs` resolves the slug from the last marker occurrence in a body, so an issue whose prose quotes the marker syntax earlier still resolves to its real appended marker
- [ ] `plan-sync.mjs` and `archive-closed-plans.mjs` obtain slugs only through the `criteria.mjs` export; no other file under `scripts/` contains its own `plan-id` regex
- [ ] Running the sync twice against an unchanged plan tree and issue set creates zero issues on the second run, including for a plan file whose body quotes the marker syntax in prose
- [ ] When the existing issue set already contains more than one issue carrying the same slug, the sync creates no further issue for that slug and logs a `WARNING` naming every duplicate issue number
- [ ] A closed issue carrying a slug suppresses re-creation of that slug (the file-still-live-after-merge path)
- [ ] Every criterion above has exactly one test named after it

## Test notes
- regression fixture: a plan file whose body quotes the marker syntax in prose (the #345/#349/#356 shape), asserting the dedup map keys on the real slug
- an issue body containing more than one marker-shaped comment resolves to the last one

## Notes
This plan file deliberately never writes the marker's literal comment syntax:
under the current first-match parser, a plan body embedding a marker-shaped
string poisons its own issue's slug resolution — which is also why the fix
must land before any other plan file that discusses the marker.
