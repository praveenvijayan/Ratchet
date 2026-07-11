---
title: Every adapter's workers show a mascot avatar in the dashboard, with bundled defaults
priority: low
labels: [herd]
blocked_by: [0051-herd-config, 0069-herd-web-dashboard]
---

Adapters are distinguished only by name text in the dashboard, so a fleet with
several adapters is hard to scan at a glance. Every worker row gets a mascot
avatar: the framework ships a small set of default character images and assigns
one per adapter out of the box, and an adapter may override it with an optional
`avatar` field (a URL or local path) in `.ratchet/herd.json`.

## Acceptance criteria
- [ ] The framework bundles a set of default mascot images, and a worker row whose adapter declares no avatar shows one of them — the same adapter always gets the same default across restarts
- [ ] An adapter may declare an optional `avatar` field in `.ratchet/herd.json`; when set, the dashboard renders that image beside the adapter's worker rows instead of the default
- [ ] An `avatar` value that is an empty string behaves exactly like an absent field: the bundled default renders, never a broken image
- [ ] Avatars render at a fixed dimension so a large source image never breaks the row layout
- [ ] An `avatar` value that fails to load in the browser (missing file, bad URL) falls back to the bundled default for that adapter, never a broken-image icon
- [ ] An `avatar` field that is present but not a string exits nonzero at config-validation time with a one-line error naming the adapter
- [ ] Every criterion above has exactly one test named after it

## Notes
`avatar` is another optional config-substitution field in the 0051 adapter
schema; the core stores and passes the string and never fetches or interprets
it — the dashboard resolves and renders it. Default images live in the
framework so `/ratchet-update` carries them to consuming repos.
