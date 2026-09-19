---
title: Deferred scope in merged PRs must become plan files — framework-agnostic debt scan gates the planning PR
priority: medium
labels: [scripts, planning]
blocked_by: [0196-no-retroactive-plans]
---

Deferral disclosure is honest but nothing consumes it: "deferred scope"
declarations in merged PR bodies never become plan files, so deferred debt
resurfaces as emergencies. A scan makes ingestion mandatory — and stays
framework-agnostic: it reads Ratchet's own protocol surface (merged PR bodies)
plus an optional host-configured source-marker pattern. No project-specific
marker convention is hardcoded in the framework.

## Acceptance criteria
- [ ] A scan lists every deferred-scope declaration in merged PR bodies that no plan file (active or `plan/done/`) covers, exits non-zero, and names each PR number
- [ ] The host repo may configure a source-marker regex; when configured, unmatched markers are listed with `file:line` — when not configured, the source scan is skipped entirely and no default project convention is assumed
- [ ] The scan runs as a check on the planning PR: it fails with the readable deferral list while unplanned debt exists and passes once every listed deferral is covered by a plan file or explicitly retired
- [ ] The covering and retiring mechanisms are documented in `plan/README.md`, and the failure output tells the author exactly which of the two to do per item
- [ ] On a repo with no deferrals and no marker config the scan exits zero (regression)
