---
title: Herd deck design revision — vinyl-figure mascots with pop-out treatment
priority: medium
labels: [herd, dashboard, design]
blocked_by: []
---

Design handoff revision to the shipped Active Agents deck (0120): the flat
generated mascots are replaced by six photographic 3D vinyl-figure renders
(transparent PNGs) that visually pop out of their card frames, with matching
deck headroom. The figures are plain image files referenced by direct URL —
never base64/data-URI inlined — living in the host repo at root `mascots/`.
Everything else on the dashboard is explicitly unchanged in this revision.

## Acceptance criteria
- [ ] The six figure PNGs are tracked in the repo under root `mascots/` and the dashboard serves them over HTTP, so a card's `<img>` loads each figure by direct URL (no base64/data-URI for the photographic art)
- [ ] An adapter's `avatar` in `.ratchet/herd.json` accepts a repo-local image path (e.g. `mascots/fig-goggles.png`) or a remote URL, and the deck card renders it — this is how the handoff's bay-to-figure pairing is configured per adapter
- [ ] Deck cards render the figure anchored to the card's 132×126 mascot slot, drawn ~192px tall so it overflows above the card's top border, unclipped, layered over the card border and dashed inner frame
- [ ] The figure carries the soft 3D drop-shadow pair and the 96×16 elliptical contact shadow at its feet, per the handoff spec
- [ ] Hovering the card lifts the figure (translateY(-7px) scale(1.05)) with the deeper drop-shadow, transitioning ~.22s ease, alongside the existing card lift
- [ ] The deck grid gains the 52px top padding and 72px row gap so overflowing figures never collide with the section header or the row of cards above
- [ ] A missing or failing image (deleted file, bad path, unreachable remote URL) falls back to the bundled default mascot — a broken-image icon is never shown
- [ ] The dashboard's image route never serves files outside the repo's image location — a path-traversal request (e.g. `../.ratchet/herd.json`) gets a 404, not file contents

## Non-functional
- Framework-purity rule from `scripts/herd-avatars.mjs` adapts, not breaks: framework code still names no CLI/model/vendor and keeps its bundled data-URI defaults as the fallback; the photographic art and its adapter mapping belong to the host repo (files + config), never the framework
- Figures load once per page via normal browser caching — live-stream updates must not re-transmit or re-fetch the art

## Test notes
- config pinning: a local-path avatar wins over the bundled default; an unknown/missing path falls back to the bundled default rather than breaking the card
- path traversal: the static image route rejects escapes from the served directory

## Notes
Design source of truth (local handoff bundle, this machine):
`/Users/pv/Downloads/design_handoff_mascot_deck/Herd Dashboard Santorini.html`
(diff against it, not screenshots) and its README with exact measurements.
The six renders already sit at repo root `mascots/` (fig-goggles, fig-hero,
fig-labcoat, fig-tropical, fig-varsity, fig-suit — serve as-is, do not recolor
or flatten). **They are currently untracked** — a worker in a fresh worktree
will not see them, so committing `mascots/` is part of this issue's PR (or
commit them to main beforehand). Handoff pairing for this repo's config:
claude-opus→fig-goggles, claude-sonnet→fig-hero, codex→fig-labcoat,
opencode-deepseek→fig-tropical, opencode-glm→fig-varsity,
opencode-grok→fig-suit. Handoff fidelity is final: colors, spacing, shadows,
and interactions are exact.
