---
title: Fresh install includes everything needed to run the herd
priority: medium
labels: [install, herd]
blocked_by: []
---

A fresh bootstrap install ships only the core scripts — no `herd*.mjs`, no
`ratchet-herd` skill, no herd UI — and nothing in the install output or README
tells the user a herd profile exists. Users who install Ratchet cannot run the
herd and get no pointer to how to add it.

## Acceptance criteria
- [ ] A fresh bootstrap install with no `--profile` flag installs every file required to run the herd (`scripts/herd*.mjs`, the `ratchet-herd` skill, and the mascots assets)
- [ ] `.ratchet-install.json` written by a default install records the herd files so `ratchet-update` and `ratchet-uninstall` manage them
- [ ] Explicit `--profile` selection still works: a user who asks for a trimmed profile set gets exactly those profiles
- [ ] Running the herd in a project where the herd files are absent (an older core-only install) prints a clear message naming the exact bootstrap/update command that adds them, never a module-not-found error
- [ ] README install section documents what a default install includes and lists the available profiles
- [ ] Every criterion above has exactly one test named after it

## Notes
Found during triage: the manifest's `herd` profile is complete and
`--profile herd` installs correctly (verified with `--dry-run` against
v4.6.0) — the gap is that herd is opt-in while the docs and install output
never mention profiles, so a default install silently lacks it. This plan makes
herd part of the default install; if the opt-in design should stay instead,
adjust the first criterion to discoverability (install output advertises
available profiles) before merging.
