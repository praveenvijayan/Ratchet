---
title: Make ratchet-update manifest-aware and profile-aware
priority: high
labels: [installer]
blocked_by: [0103-install-manifest-and-profiles, 0105-bootstrap-installer]
---

`scripts/ratchet-update.sh` hard-codes `FRAMEWORK_PATHS` and pulls everything —
all skills, all workflows, the full `scripts/` directory including tests,
plugin packaging, and docs — regardless of what the host project actually
installed. It should read the installation manifest written by the
bootstrapper and update only the files belonging to the installed profile(s).

Narrowed scope: this issue covers manifest/profile-aware *selection* only. The
first implementation attempt came in at 492 changed lines (over the 400-line
gate) because the pre-manifest test suite must be rewritten wholesale, so
hash-based modified-file protection, `--force`, and the missing-manifest guard
are split out to `0111-updater-modified-file-protection`.

## Acceptance criteria
- [ ] Updating a host project installed with only the `core` profile refreshes exactly the core-profile `framework` files at the target version — no optional-profile workflows, scripts, or skills appear, and no `*.test.mjs` or `excluded` files are pulled in
- [ ] Files recorded as `generated` in the installation manifest (`GATES.md`, `memory/`, `.env.example`, `plan/` content) are left byte-for-byte unchanged by an update
- [ ] After a successful update, the installation manifest and `.ratchet-version` record the new version for every updated path
- [ ] Every criterion above has exactly one test named after it

## Test notes
- Drive the updater against a local fixture remote with two tagged versions, asserting the on-disk diff between versions for a core-only install.
