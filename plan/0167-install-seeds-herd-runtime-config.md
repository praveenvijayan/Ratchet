---
title: Install seeds the .ratchet runtime directory so herd runs out of the box
priority: medium
labels: [install, herd]
blocked_by: []
---

A fresh bootstrap install ships the herd scripts and skill (issue #330) but
never creates the `.ratchet/` runtime directory or seeds `.ratchet/herd.json`,
and the install output never mentions either. The first herd run fails with
"`.ratchet/herd.json` not found" and the user must discover
`node scripts/herd.mjs init` on their own.

## Acceptance criteria
- [ ] A fresh bootstrap install that includes the herd profile leaves `.ratchet/herd.json` seeded with the default config, so the herd starts without any manual config step
- [ ] An existing `.ratchet/herd.json` is never overwritten by install or update — its content survives both byte-for-byte
- [ ] An explicit core-only install (`--profile core`) creates nothing under `.ratchet/`
- [ ] Install output for a herd-profile install names `.ratchet/herd.json` and the command that starts the herd
- [ ] Every criterion above has exactly one test named after it

## Notes
`herd.mjs` already has an `init` subcommand that writes the default config and
refuses to clobber an existing file, and `loadConfig` already fails with a
clear message naming it — the gap is purely that bootstrap neither runs nor
announces it, so out of the box the herd profile installs files that cannot
start.
