---
title: Lay out errors & escalations top-left with active agents to the right
priority: medium
labels: [herd, dashboard, design]
blocked_by: []
---

The active-agents deck currently spans full width above the work column, while
errors & escalations live in a toggled side panel. Reorganise the top of the
dashboard so errors & escalations sit in the top-left region and the active
agents deck sits to their right.

## Acceptance criteria
- [ ] Errors & escalations render in the top-left region of the main area
- [ ] The active agents deck renders to the right of the errors & escalations
      region on a desktop-width viewport
- [ ] With zero escalations and zero adapter-health issues, the errors region
      shows an empty state rather than a blank or broken column
- [ ] On a narrow viewport the two regions stack vertically without overlapping
- [ ] Every criterion above has exactly one test named after it
