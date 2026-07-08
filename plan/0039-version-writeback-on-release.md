---
title: Fail verification when the framework's version strings disagree
priority: medium
blocked_by: []
---

The framework version lives in four places — `.ratchet-version`,
`plugin/.claude-plugin/plugin.json`, the README framework badge, and the DOCS.md
header — and nothing checks that they agree. They can drift apart silently and
ship mixed. This is the foundational piece of the version write-back work (it
supersedes the original single-issue #82, now split): a gate that catches a
disagreeing tree before a PR opens, and a canonical rule for what "the version"
is that the release lane and the updater will both build on.

## Acceptance criteria
- [ ] `node scripts/version-consistency.mjs` exits 0 when `.ratchet-version`, `plugin/.claude-plugin/plugin.json`, the README framework badge, and the DOCS.md header all carry the same semver
- [ ] When any one of those files carries a different version, the check exits non-zero and prints each disagreeing file with the version it carries — a clear message, never a stack trace
- [ ] A bare `3.3.6` and a `v`-prefixed `v3.3.6` are treated as equal, so the check never fails on the v-prefix convention alone
- [ ] The check runs as an ordered gate in `GATES.md`, so a tree with mixed versions fails verification before any PR opens

## Notes
The four locations and the canonical version rule (compare on the bare
`MAJOR.MINOR.PATCH`, ignoring a leading `v`) should be defined once, in a form
the release write-back (`0049-release-version-writeback`) and the updater
(`0050-updater-records-tag-version`) can reuse, so the three never drift on
where versions live or how they compare. Where each file's version is read from:
the sole line of `.ratchet-version`, the `"version"` field of the plugin JSON,
the `framework-vX.Y.Z` segment of the README shields badge URL, and the
`Version X.Y.Z` line of the DOCS.md header.
