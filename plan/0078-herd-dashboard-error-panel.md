---
title: Show herd errors and escalations in a toggleable side panel
priority: medium
labels: [herd]
blocked_by: [0069-herd-web-dashboard]
---

Escalations currently stack at the top of the page and push the worker list
down; with several open errors the operator scrolls past a wall of red before
seeing the fleet. Move errors and escalations into a side panel the operator can
open to read them and close to reclaim the full width for the worker list.

## Acceptance criteria
- [ ] Errors and escalations render inside a side panel rather than stacked above the worker table
- [ ] A control toggles the panel open and closed; closing it returns the worker list to full width and opening it shows the current errors
- [ ] The control shows a count of open errors so the operator sees there are errors to read while the panel is closed
- [ ] New errors appearing while the panel is closed update the count live and do not force the panel open
- [ ] With zero errors the panel is empty and shows a one-line "no errors" message instead of a blank panel
- [ ] Every criterion above has exactly one test named after it

## Notes
Same escalation source as 0069 (`.ratchet/herd-escalations.md` / error events);
this issue only changes the presentation into an open/close panel.
