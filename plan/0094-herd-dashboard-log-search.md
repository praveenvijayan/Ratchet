---
title: Search and filter in the worker log drill-down
priority: low
labels: [herd]
blocked_by: []
---

The log drill-down live-tails a worker's log but offers no way to find
anything in it — stream-json adapter logs run to megabytes. Add search and
level/keyword filtering over the tailed content.

## Acceptance criteria
- [ ] A search box filters the displayed log to lines matching the query, updating as the user types
- [ ] New tailed lines respect the active filter as they arrive
- [ ] Clearing the search restores the full tail view at the current position
- [ ] A query matching nothing shows a "no matches" message, never a blank pane
- [ ] Every criterion above has exactly one test named after it
