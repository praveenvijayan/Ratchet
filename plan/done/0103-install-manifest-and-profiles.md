---
title: Define the canonical install manifest and core/optional profiles
priority: high
labels: [installer]
blocked_by: []
---

Ratchet has no machine-readable record of which files are framework-owned,
which are project-owned/generated, and which belong to optional features.
`ratchet-update.sh`, `ratchet-uninstall.sh`, and the docs each hard-code their
own overlapping path lists, and they already disagree (uninstall removes only a
subset of what update ships). A checked-in manifest becomes the single source
of truth every installer/updater/uninstaller tool reads, and profiles
(`core`, `watcher`, `release`, `herd`, `unattended-ci`, `claude-plugin`)
declare which optional components a host project opts into.

## Acceptance criteria
- [ ] A checked-in manifest file lists every framework file/directory with its classification: `framework` (Ratchet-owned, safe to overwrite on update), `generated` (scaffolded once, never overwritten), or `excluded` (never shipped to host projects — Ratchet plans, tests, branding, README/DOCS)
- [ ] The manifest defines a `core` profile plus named optional profiles, and every non-core workflow, script, and skill is assigned to exactly one profile
- [ ] A validation script exits non-zero and names each offending path when a file referenced by any `.github/workflows/*.yml` (or imported by a shipped script) is missing from the manifest, so the manifest can never silently drift from reality
- [ ] The validation script exits non-zero with a clear message when a manifest entry points at a path that no longer exists in the repository
- [ ] The manifest validation runs as an ordered gate in `GATES.md`, so a drifted manifest fails verification before any PR opens
- [ ] Every criterion above has exactly one test named after it
