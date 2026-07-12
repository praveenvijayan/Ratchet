---
title: Dashboard title reads "Ratchet" with "Herd Dashboard" as subheading
priority: low
labels: [herd, dashboard, design]
blocked_by: []
---

The header currently shows "Ratchet herd dashboard" as one line (from
`0130-herd-dashboard-ratchet-title`). Split it: "Ratchet" is the title,
"Herd Dashboard" a subheading under it.

## Acceptance criteria
- [ ] The header renders "Ratchet" as the main title element
- [ ] "Herd Dashboard" renders as a distinct subheading element visually subordinate to the title
- [ ] The browser tab title still names both the product and the dashboard
- [ ] Every criterion above has exactly one test named after it
