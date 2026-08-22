---
title: A failing workflow on main fires one alert — no more silent multi-week outages
priority: medium
labels: [scripts, gates]
blocked_by: []
---

Both multi-week outages (the 16-day CI break, the silent deploy failures) were
one alert away from one-day fixes: nothing tells a human when a workflow on
`main` goes red. Add an alert on main-branch workflow failure with a
host-configurable channel — the framework ships a working default that needs no
external service, and hosts can point it at their own webhook.

## Acceptance criteria
- [ ] When a workflow run on `main` completes in failure, an alert is created within one polling interval; the default channel works with GitHub alone (no external service required)
- [ ] The host can configure a webhook channel; when configured, the alert is delivered there, and a delivery failure falls back to the default channel rather than being dropped
- [ ] Alerts fire on the red transition, not per red run — a workflow that stays red across consecutive runs produces one open alert, updated, not a new alert per run
- [ ] When the workflow recovers, the open alert is marked resolved automatically
- [ ] The alert names the workflow, the run URL, and the first failing job — enough to start the fix without archaeology
