---
title: Degrade the size check gracefully on API failure and document glob rules
priority: low
blocked_by: []
---

When the per-file listing fetch fails transiently, the size check goes red —
even though the event payload's aggregate counts are sitting in env as a
designed fallback. A small, legitimate PR can fail on a GitHub hiccup. And the
exclude-pattern semantics (`*` doesn't cross `/`; bare filenames match at any
depth) differ from gitignore expectations and are documented nowhere, so a
`*.min.js` pattern silently excludes only root-level files.

## Acceptance criteria
- [ ] A transient file-listing failure falls back to the payload aggregates, with the output stating that exclusions were not applied
- [ ] GATES.md documents the exclude-pattern matching rules, including that `*` does not cross directory separators and bare filenames match at any depth
