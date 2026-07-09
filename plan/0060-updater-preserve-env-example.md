---
title: Stop ratchet-update from overwriting a consumer's .env.example
priority: medium
labels: []
blocked_by: []
---

`scripts/ratchet-update.sh` lists `.env.example` in `FRAMEWORK_PATHS`, so every
`/ratchet-update` on a Ratchet-enabled project overwrites that project's
`.env.example` with upstream's — silently discarding any env keys the project
added. This contradicts the updater's own promise: its header comment and the
closing "Untouched (project-owned)" line already say env config is left alone.
Treat `.env.example` as project-owned, like `.env`.

## Acceptance criteria
- [ ] `.env.example` is absent from `FRAMEWORK_PATHS` in `scripts/ratchet-update.sh`
- [ ] Running the updater against a repo whose `.env.example` differs from upstream leaves that file byte-for-byte unchanged
- [ ] `scripts/ratchet-update.test.mjs` still passes — no workflow-invoked or imported script is dropped from `FRAMEWORK_PATHS` by this change (only `.env.example` is removed)
- [ ] The updater's comments and its closing "Untouched (project-owned)" line name `.env.example` alongside `.env`, so the documented contract matches the behavior

## Notes
`.env.example` is not a script, so removing it does not affect the
FRAMEWORK_PATHS script-coverage assertion. The fix is a one-line removal plus
matching the surrounding documentation.
