---
title: Herd dashboard keeps lifecycle stage headers visible when empty
priority: low
labels: [herd, dashboard]
blocked_by: []
---

The work list only renders lifecycle groups that hold rows. With nothing in
flight the operator sees a bare "No workers." hint — no indication the
pipeline stages (Awaiting review / Escalated / Terminal) exist or what lands
in each. Keep every pipeline stage's header on screen with a dashed
empty-state note, the same visual pattern as the Live Workers deck note.

## Acceptance criteria
- [ ] With zero workers, the dashboard renders headers for Awaiting review, Escalated, and Terminal, each with an empty-state note describing what lands in that stage
- [ ] An empty `live` group renders no extra header or note (the Live Workers deck header and its existing empty note already cover that stage)
- [ ] The `other` drift-guard group appears only when a worker carries an unknown status key, never as an empty header
- [ ] A stage holding rows renders its rows, not the empty-state note
- [ ] `groupWorkers([])` returns the always-shown stages with empty row lists and omits `live`/`other`, keeping the server grouping in sync with the browser rendering
- [ ] Every criterion above has exactly one test named after it
