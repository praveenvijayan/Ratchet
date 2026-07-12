---
title: Updater adopts installs that have no .ratchet-install.json
priority: medium
labels: [install, update]
blocked_by: []
---

`ratchet-update` refuses to run in any repo that has the framework files but no
`.ratchet-install.json` — the only advice is a full reinstall. Repos that got
Ratchet by direct copy (rather than `bootstrap.sh`, which writes the record)
can therefore never update, even when `.ratchet-version` and the manifest are
present and the working tree is clean.

## Acceptance criteria
- [ ] In a repo with framework files and a readable `.ratchet-version` but no `.ratchet-install.json`, the updater offers a documented adoption path that writes a valid `.ratchet-install.json` (profiles and per-file hashes for the recorded version) without a full reinstall
- [ ] Adoption never destroys local changes: a file that differs from the pristine release at the recorded version is reported by path and left byte-for-byte untouched
- [ ] After adoption completes, `ratchet-update` runs to completion in the same repo with no further manual steps
- [ ] When adoption cannot proceed (missing or unreadable `.ratchet-version`, or the recorded release cannot be fetched), the user sees a clear message naming the exact reinstall command — never a stack trace
- [ ] Every criterion above has exactly one test named after it

## Notes
Observed on a repo seeded by copying a local checkout: `.ratchet-version` said
5.0.0, the updater script was present, working tree clean — only the missing
install record blocked, and the preflight's only remedy was reinstall via
bootstrap. The refusal itself is correct (no hashes means framework files and
local edits are indistinguishable); the gap is the absence of a safe adoption
path for that state.
