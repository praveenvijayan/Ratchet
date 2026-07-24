---
title: Play a distinct sound cue on herd agent milestones in the dashboard
priority: low
labels: [herd]
blocked_by: []
---

The dashboard is silent: an operator watching another window has no idea an
agent started, opened a PR, or died until they look back. The `/api/stream` SSE
feed already carries every worker lifecycle event, so the dashboard can play a
short audible cue on the milestones that matter — dispatch, claim, PR opened,
worker exit, escalation — with a distinct cue per milestone so the operator can
tell them apart without looking.

## Acceptance criteria
- [ ] A dispatch, claim, PR-opened, worker-exit, and escalation event each play a cue, and the five cues are audibly distinct from one another
- [ ] Every other event type on the stream plays no cue
- [ ] Events already present when the page loads (backlog replay) play no cue, so opening the dashboard is silent regardless of history size
- [ ] A burst of milestone events arriving together plays each cue without overlapping into noise, and never plays the same event's cue twice
- [ ] When the browser blocks or fails audio playback, the dashboard renders and streams normally and shows a one-time inline hint that sound needs a click to enable — never a raw error or a repeated warning per event
- [ ] Every criterion above has exactly one test named after it
