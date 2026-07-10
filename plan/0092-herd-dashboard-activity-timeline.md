---
title: Per-issue activity timeline from the event stream
priority: low
labels: [herd]
blocked_by: []
---

`events.jsonl` already records every lifecycle transition, but the dashboard
shows only current state — the story of a run (dispatched, claimed, PR opened,
reworked, exited) is invisible. Render a per-issue timeline from the events.

## Acceptance criteria
- [ ] Selecting an issue shows its events in chronological order with timestamp, event type, and the adapter/attempt/PR fields each event carries
- [ ] New events for the selected issue append to the timeline live without a page reload
- [ ] An issue with no events shows a one-line "no activity recorded" message, never an empty pane or an error
- [ ] A malformed event line in the stream is skipped with the remaining timeline still rendering
- [ ] Every criterion above has exactly one test named after it
