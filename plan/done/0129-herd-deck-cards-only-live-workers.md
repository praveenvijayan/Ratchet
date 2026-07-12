---
title: Herd deck mascot cards appear and disappear with live workers
priority: medium
labels: [herd, dashboard]
blocked_by: []
---

The Active Agents deck renders one mascot card for every adapter configured in
herd.json, regardless of whether the adapter has a live worker — a spawn only
flips the duty chip. The deck should show the fleet that is actually running:
a card appears when an adapter spawns a worker and disappears when the worker
exits, with idle capacity shown as empty bays.

## Acceptance criteria
- [ ] The deck renders a mascot card only for adapters with a live worker (`activeIssue` set); a configured adapter with no live worker renders no mascot card
- [ ] With zero live workers the deck renders zero mascot cards and all bays as dashed "Bay open" placeholders — never a broken or empty section
- [ ] A card appears on the first dashboard refresh after an adapter's worker spawns and disappears on the first refresh after that worker exits
- [ ] The deck header tally equals the number of mascot cards rendered
- [ ] The roster count (configured adapters out of bay capacity, e.g. 6/10) remains visible in the deck header so fleet composition is not lost
- [ ] An adapter entry with missing or malformed worker data is treated as idle (no card) — the deck never throws or renders a partial card

## Notes
Supersedes the "all configured adapters still render a card" behaviour accepted
in closed #276 (mascot deck) and #287 (truthful tally). `buildDeck` in
`scripts/herd-ui.mjs` currently maps every adapter in config; the live-worker
signal already exists as `activeIssue`.
