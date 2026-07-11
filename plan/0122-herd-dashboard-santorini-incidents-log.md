---
title: Herd dashboard Santorini reskin — incidents aside & log console
priority: medium
labels: [herd, dashboard, design]
blocked_by: [0121-herd-dashboard-santorini-sections-rows]
---

Final slice of the Santorini reskin of `scripts/herd-ui.mjs`, building on the
foundation (`0119`) and the section/row slice (`0121`). This slice restyles the
right-column incidents aside and the log console. It is chained after `0121`
(not merely after `0119`) because both slices edit the same `PAGE_HTML` template
and must land in sequence to avoid merge conflicts. The mascot deck stays
separate (`0120`).

## Acceptance criteria
- [ ] Errors & escalations panel renders as a bordered aside with an inverted (ink background) panel head; each incident is a card, and flagged/unresolved incidents get the accent border, accent-colored action buttons, and offset shadow while resolved ones are de-emphasised
- [ ] The adapter-failure alerts and per-adapter breakdown keep rendering inside the restyled aside, matching the incident-card visual language
- [ ] Log console renders lines as timestamp / bold event / faint meta, with escalation events in the accent color; the filter input matches the design styling and hides non-matching lines as typed, showing a visible "No matches." message when the query matches nothing
- [ ] The acknowledge and copy-command actions keep working, and an acknowledge failure shows a visible error on the incident card, never a raw stack trace
- [ ] Every criterion above has exactly one test named after it

## Non-functional
- Pure reskin: escalation acknowledge/copy actions, adapter-failure display, and the log search/filter keep working and the existing herd-ui test suites (`herd-ui`, `herd-ui-escalation`, `herd-ui-acknowledge`, `herd-ui-log-search`, `herd-ui-adapter-failures`) stay green
- No new runtime dependency and no build step

## Notes
Design source of truth: Claude Design project `040de050-b19a-4271-bf65-d8fa03b3c6f6`,
file `Herd Dashboard Santorini.html` (see `0119` for retrieval). Match the
mockup's `.panel`/`.incident`/`.btn` and log-console CSS — the ink-inverted
panel head, accent incident borders, dashed rules — rather than re-inventing
values. Keep the existing test hooks intact: preserve the `.esc`/`esc resolved`
class names, the `.esc.resolved .actions { display:none }` rule, the
`occurrences`/`esc-error` classes, the `ackEsc`/`copyCmd` handlers and their
`data-cmd`/`/api/acknowledge` wiring, and the log elements
`#logsearch`/`#lognomatch`/`pre#log` (restyle via CSS, do not rename).
