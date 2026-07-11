---
title: Reflect herd.json avatar edits on the dashboard without a restart
priority: medium
labels: [herd, dashboard]
blocked_by: []
---

The dashboard loads `.ratchet/herd.json` once at server start
(`scripts/herd-ui.mjs` `run()` captures `config` into the server closure), so
adding or changing an adapter's `avatar` does nothing until the operator kills
and restarts the dashboard. When the new URL then fails to load, `onerror`
silently swaps back to the bundled mascot — the operator sees "my avatar was
ignored" with no signal of either cause. Observed live: `avatar: "<link>"`
added to config, dashboard kept showing the old image.

## Acceptance criteria
- [ ] Editing an adapter's `avatar` in `.ratchet/herd.json` while the dashboard is running is reflected in the next snapshot the browser receives, without restarting the server
- [ ] Other config-derived dashboard values from the same read (e.g. `claimTimeoutSeconds`, poll-derived heartbeat threshold) update consistently with the avatar — no half-old, half-new snapshot
- [ ] While `herd.json` is missing or unparseable, the dashboard keeps serving the last good config and the server does not crash
- [ ] An avatar URL that fails to load in the browser still falls back to the bundled mascot with no broken-image icon, as today
