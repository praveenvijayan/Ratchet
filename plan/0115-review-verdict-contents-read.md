---
title: review-verdict workflow cannot check out the repo — permissions block drops contents:read
priority: high
labels: []
blocked_by: []
---

`review-verdict.yml` declares `permissions: issues: write`. A non-empty
`permissions` block drops every unlisted default — including `contents: read` —
so `actions/checkout` fails with `fatal: repository not found` on private
repos and the flip never runs. Confirmed in host project
`mahmya-digital/digital-workforce` (Actions run 29146589771); the file is a
`framework`-class entry in `ratchet-manifest.json`, so every host installs the
broken copy.

## Acceptance criteria
- [ ] `review-verdict.yml`'s `permissions` block grants `contents: read` alongside `issues: write`, and a test guards the block against regressing to `issues: write` alone

## Notes
Direct port of digital-workforce PR #192 (merged host-side fix). Host copies
patched locally now diverge from the manifest hash and are skipped by
`ratchet-update` as locally modified until this lands and hosts re-sync.
