---
title: Ship the mascots folder to host projects via the install manifest
priority: medium
labels: [herd, installer]
blocked_by: []
---

The six vinyl-figure mascots now live at repo root `mascots/` (merged via
PR #290), but they are absent from `ratchet-manifest.json`, so a first-time
install of Ratchet into a host project never delivers them — the herd
dashboard there would have nothing to serve. Add the folder to the manifest so
installers ship it on first install, with once-scaffolded semantics: the art
is a starting set the host may replace, so updates must never clobber it.

## Acceptance criteria
- [ ] A first-time install into a fresh host project delivers `mascots/` with all six figure PNGs (fig-goggles, fig-hero, fig-labcoat, fig-tropical, fig-varsity, fig-suit)
- [ ] `mascots/` is declared in `ratchet-manifest.json` and the `scripts/manifest-check.mjs` gate passes
- [ ] `/ratchet-update` on a host project never overwrites an existing mascot file — a host that replaced or recolored its art keeps it across updates
- [ ] `/ratchet-update` on a host project installed before this change adds the missing `mascots/` folder — an older install is not stranded without art
- [ ] `ratchet-uninstall` keeps `mascots/` by default and removes it only when explicitly purged, matching the existing generated-file behaviour

## Notes
Companion to 0127-herd-deck-vinyl-figure-popout (dashboard serves and renders
the art); this issue only makes the installer/updater/uninstaller deliver the
files. Manifest classes and their exact semantics are documented in
`ratchet-manifest.json`'s `_readme` and exercised by
`scripts/install-lifecycle.test.mjs`. Prior history: this plan briefly existed
on main as issue #291 (closed; created by a mistaken direct push, since
reverted) — if plan-sync matches the plan-id marker it may update/reopen that
thread instead of minting a new issue; either outcome is acceptable.
