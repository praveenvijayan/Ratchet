---
title: Add the Active Agents mascot deck to the herd dashboard
priority: medium
labels: [herd, dashboard, design]
blocked_by: [0119-herd-dashboard-santorini-theme]
---

The Santorini design gives the fleet a center-stage "Active Agents" deck: one
mascot card per adapter in a flexible grid, with empty docking bays showing the
remaining capacity. Today adapters only appear as small avatar chips on work
rows; the deck makes fleet composition and per-adapter health readable at a
glance.

## Acceptance criteria
- [ ] Active Agents section renders one mascot card per configured adapter in an auto-fill grid (`minmax(206px, 1fr)`) that reflows from 1 to 10 adapters without layout changes
- [ ] Each mascot card shows the adapter family label (top-left), its bay number (top-right), the mascot image, the adapter name, a duty chip, and a three-cell vitals strip (dispatched / failed / succeeded counts)
- [ ] Duty chip shows active styling with "dispatched · #N" (the claimed issue number) when the adapter has a live worker, and idle styling with "standing by" otherwise
- [ ] Vitals render zero counts in the faint zero treatment rather than hiding the cell, so a fresh adapter still shows all three cells
- [ ] Bays beyond the configured adapters render as dashed empty-bay placeholders with bay number and "Bay open" label, up to the 10-bay capacity
- [ ] When an adapter's own avatar image fails to load, the card swaps to the bundled data-URI mascot — a broken-image icon is never shown
- [ ] Section heading shows the live adapter tally and the note "10 bays · new agents dock automatically"

## Non-functional
- Mascot art must keep the framework-purity rule from `scripts/herd-avatars.mjs`: bundled art ships inside the framework (inline data URIs), names no CLI/model/vendor, and never requires a network fetch or an asset directory

## Notes
Design source of truth: Claude Design project `040de050-b19a-4271-bf65-d8fa03b3c6f6`,
file `Herd Dashboard Santorini.html` (claude_design MCP at
`https://api.anthropic.com/v1/design/mcp`, auth via `/design-login`; or
DesignSync `get_file`). The design project also holds character art under
`assets/mascots/*.png` and a pure-CSS mascot fallback (`.head`/`.body`/`.orbit`
rules with per-adapter colorways) — either satisfies the criteria as long as
the framework-purity rule above holds.
