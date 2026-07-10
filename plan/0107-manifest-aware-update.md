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

## Acceptance criteria
- [ ] Updating a host project installed with only the `core` profile refreshes exactly the core-profile `framework` files at the target version — no optional-profile workflows, scripts, or skills appear, and no `*.test.mjs` or `excluded` files are pulled in
- [ ] Files recorded as `generated` in the installation manifest (`GATES.md`, `memory/`, `.env.example`, `plan/` content) are left byte-for-byte unchanged by an update
- [ ] After a successful update, the installation manifest and `.ratchet-version` record the new version for every updated path
- [ ] A framework file the host has locally modified is not silently overwritten: the update lists each modified path and requires an explicit flag to replace it
- [ ] Running the updater in a project with no installation manifest fails with a clear message pointing at the bootstrap/migration path, leaving the project unchanged — never a stack trace or partial update
- [ ] Every criterion above has exactly one test named after it

## Test notes
- Drive the updater against a local fixture remote with two tagged versions, asserting the on-disk diff between versions for a core-only install.
