---
title: Herd deck header tally and vitals must say what they count
priority: low
labels: [herd, dashboard]
blocked_by: []
---

The "Active Agents" deck header tally is `deck.length` — the number of
*configured* adapters — so it reads "Active Agents (6)" while the summary strip
correctly shows 0 live workers. And the per-card "OK" vital counts dispatches
whose *spawn* succeeded (`adapterDispatchStats` treats any status other than
`dispatch-failed` as success), not work that produced a PR — an adapter whose
every run ended escalated still shows a green-looking OK count. Both numbers
are correct per their real definitions; the labels claim something else.

## Acceptance criteria
- [ ] The deck header tally counts only adapters with a live worker (`activeIssue` set), and a snapshot with zero live workers renders the tally as 0
- [ ] The roster/bay usage (configured adapters out of capacity) remains visible in the deck header, labelled as roster or bays, so fleet composition is not lost
- [ ] The third vitals cell is labelled so it reads as successful spawns/launches, not completed work — the string "OK" no longer appears as that cell's label
- [ ] All configured adapters still render a card when none has a live worker

## Notes
Tally source: `renderDeck` sets `decktally` to `cards.length`;
`buildDeck` maps every adapter in config (`scripts/herd-ui.mjs`). Label-and-
count changes only — no change to `adapterDispatchStats` semantics, which the
broken-adapter alert depends on.
