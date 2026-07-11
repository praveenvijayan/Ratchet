---
title: Herd dashboard Santorini reskin — sections, summary strip, work rows
priority: medium
labels: [herd, dashboard, design]
blocked_by: [0119-herd-dashboard-santorini-theme]
---

Second slice of the Santorini reskin of `scripts/herd-ui.mjs`, building on the
foundation (`0119`: palette, type, header, grid). This slice restyles the
left-column content: the section-heading pattern, the summary strip, and the
work rows. The incidents aside and log console come in `0122`; the mascot deck
is separate (`0120`).

## Acceptance criteria
- [ ] Section headings render as a serif uppercase title + circled count tally + horizontal rule ending in a diamond, per the design's `.sec` pattern, applied to each lifecycle group heading (awaiting review, live, escalated, terminal, other)
- [ ] Summary strip renders each stat as a bordered block with offset shadow (large serif number + mono uppercase label); the escalations stat and the errors chip get the accent (`--terra`) alert treatment with the error count in a filled pill
- [ ] Work rows render as bordered cards with issue-number link, uppercase status chip (distinct styling for dispatched / ready-for-review / stale-claim), assignee with avatar chip, title, and a dashed-rule telemetry strip (attempts, age, PR, cost, tokens in/out)
- [ ] Missing telemetry values show an em dash in faint style, never blank or "undefined" (an unreadable usage number, a worker with no PR, or a missing title all render "—")
- [ ] Every criterion above has exactly one test named after it

## Non-functional
- Pure reskin: summary-strip counts, error/escalation badge counts, avatar fallback, and PR-checks display keep working and the existing herd-ui test suites (`herd-ui`, `herd-ui-summary-strip`, `herd-avatar`) stay green
- No new runtime dependency and no build step

## Notes
Design source of truth: Claude Design project `040de050-b19a-4271-bf65-d8fa03b3c6f6`,
file `Herd Dashboard Santorini.html` (see `0119` for retrieval). Match the
mockup's `.sec`, `.stat`, and `.row`/telemetry CSS — borders, offset shadows,
dashed rules — rather than re-inventing values. Keep the existing test hooks
intact: preserve the `.summarystrip`/`.sumcell` render structure and the
`#errtoggle`/`#errcount` errors chip (restyle via CSS, do not rename), and keep
the em-dash formatters (`usdCell`/`tokCell`/`issueCell`) that already emit the
faint "—".
