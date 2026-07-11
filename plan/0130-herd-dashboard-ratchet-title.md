---
title: Rename herd dashboard header to "Ratchet herd dashboard"
priority: low
labels: [herd, dashboard, design]
blocked_by: []
---

The header brand currently reads "Herd Dashboard" in all-caps. Rename it to
"Ratchet herd dashboard" so the product name leads, with "herd dashboard"
rendered in lowercase rather than the current uppercase treatment.

## Acceptance criteria
- [ ] The header brand renders the text "Ratchet herd dashboard", with the
      "herd dashboard" portion in lowercase (not uppercased by CSS)
- [ ] "Ratchet" is visually distinguished from the lowercase "herd dashboard"
      (e.g. its own weight/size/element), so the product name leads
- [ ] The browser tab `<title>` reads "Ratchet herd dashboard"
- [ ] Every criterion above has exactly one test named after it
