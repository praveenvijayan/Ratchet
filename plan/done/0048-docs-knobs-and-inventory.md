---
title: Document the remaining knobs and fix the workflow inventory drift
priority: low
blocked_by: []
---

Small documentation debts left by the last wave. `REWORK_GRACE_HOURS` is a real
sweep knob documented nowhere. The DOCS §6 workflow table lists six of seven
workflows (archive-closed-plans appears only in the layout), and the docs
regression test greps the whole file so it can't catch the inventory gap.
plan/README.md still says an invalid plan file "is skipped" when it now aborts
the whole sync with nothing changed. The release row omits that a first release
seeds its version from `.ratchet-version`.

## Acceptance criteria
- [ ] `REWORK_GRACE_HOURS` is documented alongside `STALE_HOURS` where the sweep is described
- [ ] The DOCS §6 workflow table lists all seven workflows, and the docs regression test checks the inventory section rather than the whole file
- [ ] plan/README.md describes the abort-on-invalid-frontmatter semantics (no file "skipped", nothing partially synced)
- [ ] The release documentation states that a first release seeds its version from `.ratchet-version`
