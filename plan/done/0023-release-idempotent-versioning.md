---
title: Make the release lane idempotent and version-aware
priority: medium
blocked_by: []
---

`release.mjs` computes the next version from the latest *release*, not from
tags: a tag that exists without a backing release (manual tag, deleted release,
re-run after a partial failure) makes the create call fail with an unhandled
422. And on a repo with no releases it starts from `v0.0.0`, so Ratchet's own
first release would tag `v0.0.1` while the framework advertises 3.3.6 — with
DOCS.md telling consumers to pin to tags that don't exist yet.

## Acceptance criteria
- [ ] Running the release when the computed tag already exists exits with a clear message and creates nothing partial — never an unhandled API error
- [ ] Re-running after a previously failed run completes cleanly (no manual tag/release surgery needed)
- [ ] The first release on a repo with no prior releases seeds its version from `.ratchet-version` when present, instead of `v0.0.1`
- [ ] DOCS.md's pin-to-tag guidance matches reality (it no longer instructs pinning to tags that may not exist)
