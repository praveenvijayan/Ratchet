---
title: Let a herd adapter declare an image shown for its workers in the dashboard
priority: low
labels: [herd]
blocked_by: [0051-herd-config, 0069-herd-web-dashboard]
---

Adapters are distinguished only by name text in the dashboard, so a fleet with
several adapters is hard to scan at a glance. An adapter gains an optional
`image` field (a URL or local path) that the dashboard renders next to every
worker dispatched on that adapter, giving each adapter a recognisable icon.

## Acceptance criteria
- [ ] An adapter may declare an optional `image` field in `.ratchet/herd.json`; it loads and validates like any other optional adapter field
- [ ] The dashboard renders the declared image beside each worker row whose adapter has one, sized to a fixed dimension so a large source image never breaks the layout
- [ ] An adapter with no `image` field renders the existing adapter-name text only, with no broken-image placeholder (back-compat)
- [ ] An `image` value that fails to load in the browser (missing file, bad URL) falls back to the adapter-name text, never a broken-image icon
- [ ] An `image` field that is present but not a string exits nonzero at config-validation time with a one-line error naming the adapter
- [ ] Every criterion above has exactly one test named after it

## Notes
`image` is another optional config-substitution field in the 0051 adapter
schema; the core stores and passes the string and never fetches or interprets
it — the browser resolves and renders it.
