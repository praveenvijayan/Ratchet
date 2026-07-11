---
title: Herd dashboard — deck and workers/log side-by-side grid, natural page scroll on desktop
priority: medium
labels: [herd, dashboard, design]
blocked_by: []
---

Follow-up layout revision to the shipped column flip (#316). The 100vh cap with
per-column internal scrolling feels cramped: instead, `#deckwrap` becomes a
two-column grid — active agents deck on the left, workers pane plus log console
on the right — and the desktop page scrolls as one document. Main content
widens to near full width and the body background flattens to the solid paper
colour. A hand-tuned CSS prototype of this layout exists (described in the
issue notes); it also left two rough edges that must not ship: a `//` line
comment inside the embedded CSS (invalid CSS) and empty placeholder rules.

## Acceptance criteria
- [ ] On a desktop-width viewport `#deckwrap` lays out as a two-column grid:
      the deck section (headers + `#deck`) in the left column, the workers
      pane (`#layout`) and the log console together in the right column
- [ ] On desktop the page scrolls as a normal document when content overflows:
      no `overflow:hidden` viewport cap on `body`/`main` and no fixed 100vh
      containment — scrolling the page reveals overflowing deck/worker/log
      content
- [ ] The errors & escalations panel keeps its own scrollable region and, with
      zero escalations and zero adapter-health issues, shows its empty state
      rather than a blank or broken panel
- [ ] `main` spans near full viewport width on desktop instead of the previous
      1480px cap
- [ ] The body background renders as the solid paper colour with no trailing
      gradient layer
- [ ] On a narrow viewport (at or below the 1180px breakpoint) the grid
      collapses to a single column with no overlapping regions and normal page
      scrolling
- [ ] The embedded `PAGE_HTML` stylesheet contains no `//` line comments and
      no empty placeholder rules
- [ ] Every criterion above has exactly one test named after it

## Non-functional
- Layout-only change: keep the existing element ids and test hooks
  (`#deckwrap`, `#deck`, `#layout`, `#workers`, `#logpane`, `#errpanel`,
  `#escalations`, `#logsearch`, `#lognomatch`) so existing herd-ui suites stay
  green; new wrapper elements may be added but must not remove or rename these
- No new runtime dependency and no build step

## Notes
Intentionally supersedes the 100vh-cap behaviour accepted in #316 — the design
has iterated. A local prototype changed only the embedded `PAGE_HTML` CSS and
markup in `scripts/herd-ui.mjs`: `#deckwrap` grid with two wrapper divs
(deck column, workers+log column), page-scroll unlocked in the desktop media
query, `main` near-full-width, flattened background. Do not copy its rough
edges (`//` CSS comment, empty `.wrap-*` placeholder rules).
