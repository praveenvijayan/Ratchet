---
title: Add a persisted mute/volume control for dashboard milestone cues
priority: low
labels: [herd]
blocked_by: [0187-herd-ui-milestone-sound-cues]
---

Milestone cues are useless if the operator cannot silence them in a shared room
or turn them down. Give the dashboard a mute toggle and a volume control whose
setting survives a reload, so the choice is made once rather than every time
the page refreshes.

## Acceptance criteria
- [ ] The dashboard header shows a mute toggle whose icon/label reflects the current state
- [ ] Toggling to muted stops all milestone cues immediately while events keep streaming and rendering
- [ ] The mute state and volume level survive a page reload and apply before the first event of the new session plays
- [ ] Volume set to zero behaves as muted and plays nothing
- [ ] When the stored preference is missing or unreadable (cleared or corrupt storage), the dashboard falls back to a documented default and renders the control normally, never an error
- [ ] Every criterion above has exactly one test named after it
