---
title: Flip dashboard columns — agents/workers/logs left, errors & escalations right, 100vh scroll regions
priority: medium
labels: [herd, dashboard, design]
blocked_by: []
---

The dashboard top region currently places errors & escalations in the left
column and the active agents deck on the right, with the workers pane and log
console stacked full-width below, so the page grows unbounded. Flip the
columns and contain the page: active agents, workers, and the log console
share the left column; errors & escalations take the right column; the page is
capped at viewport height with each column scrolling its own content.

## Acceptance criteria
- [ ] On a desktop-width viewport the active agents deck renders in the left
      column and the errors & escalations panel renders in the right column
- [ ] The workers pane and the log console render in the left column beneath
      the active agents deck, inside the same `#deckwrap` container, so
      agents, workers, and logs form one left-side column
- [ ] The page layout is capped at 100vh: the header/top strip stays visible
      and each column scrolls its own overflowing content instead of the whole
      page growing past the viewport
- [ ] On a narrow viewport the columns stack vertically without overlapping
      and the 100vh cap does not clip content — the page scrolls normally
- [ ] With zero escalations and zero adapter-health issues the right column
      shows its empty state rather than a blank or broken column
- [ ] Every criterion above has exactly one test named after it

## Non-functional
- Layout-only change: keep the existing element ids and test hooks
  (`#deckwrap`, `#deck`, `#workers`, `#logpane`, `#errpanel`, `#escalations`,
  `#logsearch`, `#lognomatch`) so the existing herd-ui test suites stay green
- No new runtime dependency and no build step
