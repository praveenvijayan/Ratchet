---
title: Herd dashboard header shows the project name
priority: low
labels: [herd, dashboard]
blocked_by: []
---

The dashboard header names the product but not the project it is watching.
Show the project's name in the header so a user running herd against several
repositories can tell which one a dashboard belongs to.

## Acceptance criteria
- [ ] The header renders the project name under the subhead, styled consistently with the existing brand block
- [ ] When the repository has a GitHub origin remote, the displayed name is the `owner/repo` slug
- [ ] When no origin remote exists, the displayed name falls back to the repository root directory's basename
- [ ] Every dashboard snapshot carries the project name, so the value survives live updates without changing
- [ ] When a snapshot carries no project name, the header element is hidden rather than rendered empty
- [ ] Every criterion above has exactly one test named after it

## Notes
Server resolves the name once at startup (in `herd-ui.mjs`) and passes it into
the dashboard server; the client renders it from the snapshot.
