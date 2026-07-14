---
title: Herd dashboard renders mascot card for adapters renamed after dispatch
priority: low
labels: [herd, dashboard]
blocked_by: []
---

State entries record the adapter's config name at dispatch time. Renaming or
removing that adapter in the config afterwards makes two lookups miss on the
stale name — the avatar resolution in `buildWorkers` and the deck-roster match
in the client's `rowHtml` — so the worker's card degrades to a plain row with
a tiny generic SVG face instead of the mascot character card.

## Acceptance criteria
- [ ] A worker whose recorded adapter is absent from the deck roster still renders the mascot character card, using the row's own avatar (or the bundled default) and the recorded adapter name
- [ ] That card omits the per-adapter vitals block (dispatches/failures/successes) — those stats belong to configured adapters only
- [ ] An adapterless row (e.g. the survey's stale-claim sentinel) keeps the plain row with the faint em dash
- [ ] Every criterion above has exactly one test named after it

## Notes
This is the render-side fallback. The underlying data problem — state entries
pinned to config adapter names that can change — may deserve a first-class
answer later (remap known renames on reconcile, or store avatar/family on the
entry at dispatch so the row stays self-describing). The client also needs the
family segment (text before the first hyphen) that the server derives via
`adapterFamily`; keeping the two in sync is part of this issue's scope.
