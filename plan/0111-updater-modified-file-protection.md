---
title: Hash-based modified-file protection for ratchet-update
priority: high
labels: [installer]
blocked_by: [0107-manifest-aware-update]
---

Split from `0107-manifest-aware-update` to keep each PR under the 400-line
gate. With profile-aware selection in place, the updater must also protect
host-modified framework files and refuse to run without an installation
manifest, instead of silently overwriting or partially updating.

## Acceptance criteria
- [ ] A framework file the host has locally modified since install is not silently overwritten: the update lists each modified path, skips it, and exits non-zero unless an explicit `--force` flag is given
- [ ] With `--force`, listed modified files are replaced and the run reports each replacement
- [ ] After install or update, the installation manifest records a content hash for every installed framework file, so a later run can detect local modification
- [ ] Running the updater in a project with no installation manifest fails with a clear message pointing at the bootstrap/migration path, leaving the project unchanged — never a stack trace or partial update
- [ ] Every criterion above has exactly one test named after it

## Test notes
- Drive against the same local fixture-remote harness as `0107`: install, modify a shipped file, then assert the refusal, the `--force` path, and the missing-manifest guard.
