---
title: Herd deck design revision — vinyl-figure mascots with pop-out treatment
priority: medium
labels: [herd, dashboard, design]
blocked_by: []
---

Design handoff revision to the shipped Active Agents deck (0120): the flat
generated mascots are replaced by six photographic 3D vinyl-figure renders
(transparent PNGs) that visually pop out of their card frames, with matching
deck headroom. Everything else on the dashboard is explicitly unchanged in
this revision.

## Acceptance criteria
- [ ] Deck cards render the vinyl-figure art as the bundled default mascots: the figure is anchored to the card's 132×126 mascot slot, drawn ~192px tall so it overflows above the card's top border, unclipped, and layered over the card border and dashed inner frame
- [ ] The figure carries the soft 3D drop-shadow pair and the 96×16 elliptical contact shadow at its feet, per the handoff spec
- [ ] Hovering the card lifts the figure (translateY(-7px) scale(1.05)) with the deeper drop-shadow, transitioning ~.22s ease, alongside the existing card lift
- [ ] The deck grid gains the 52px top padding and 72px row gap so overflowing figures never collide with the section header or the row of cards above
- [ ] Each configured adapter keeps the same figure across dashboard restarts (deterministic per adapter name), and an operator can pin a specific bundled figure to an adapter via `.ratchet/herd.json`, so the handoff's exact bay-to-figure pairing is reproducible in a host repo
- [ ] An adapter's own `avatar` config still takes precedence over the bundled figure, and a failed avatar load still falls back to the bundled figure — a broken-image icon is never shown
- [ ] Mascot art renders with no network fetch and no 404 path — the figures ship inside the framework

## Non-functional
- Framework-purity rule from `scripts/herd-avatars.mjs` holds: the art ships in the framework, and framework code names no CLI/model/vendor — the handoff's `claude-opus → fig-goggles` style mapping is host-repo configuration, never framework code
- The six PNGs total ~1.4MB (~1.9MB base64). A dashboard left open must not re-receive the art on live-stream updates — the figures load once per page, not once per snapshot

## Test notes
- deterministic assignment: same adapter name yields the same figure across repeated calls and across the full pool
- config pinning: a pinned figure wins over the hash assignment; an unknown pin value falls back to the hash assignment rather than breaking the card

## Notes
Design source of truth (local handoff bundle, this machine):
`/Users/pv/Downloads/design_handoff_mascot_deck/Herd Dashboard Santorini.html`
(diff against it, not screenshots), README with exact measurements at
`/Users/pv/Downloads/design_handoff_mascot_deck/README.md`, and the six
transparent renders in
`/Users/pv/Downloads/design_handoff_mascot_deck/assets/mascots/*.png`
(fig-goggles, fig-hero, fig-labcoat, fig-tropical, fig-varsity, fig-suit —
serve as-is, do not recolor or flatten; supplied by the design owner).
Handoff fidelity is final: colors, spacing, shadows, and interactions are
exact. Inlining the art as data URIs (the existing `herd-avatars.mjs`
pattern) keeps the diff inside the PR file cap; whether inline or otherwise,
the purity and page-weight constraints above decide, not the mechanism.
