---
title: Gates run on every PR — no branch or path carve-outs — and red is unmergeable
priority: high
labels: [scripts, gates]
blocked_by: [0199-fix-standing-red-gates]
---

Branch protection and required contexts exist (0008, 0033), but gate coverage
has carve-outs: framework PRs (`scripts/**`, `.github/**`) and side branches
have merged without the same checks agent PRs get. The 16-day CI outage and the
red merges came from checks being advisory in practice. Once the suite is green
on a clean tree (0199), close the loop: every PR into `main` runs the same
gates, and a red check makes the PR unmergeable for everyone, including admins.

## Acceptance criteria
- [ ] The pr-gates workflow triggers on every PR targeting `main`, regardless of head-branch name or paths touched — a PR changing only `scripts/**` or `.github/workflows/**` gets the same required checks as an agent PR
- [ ] With protection applied, a PR with any failing required check cannot be merged — verified against the live API, including with an admin token (`enforce_admins` on)
- [ ] The documented emergency path (revert/hotfix protocol) is the stated alternative to bypassing a red check, and the docs no longer describe any advisory interpretation of a failing gate
- [ ] A PR whose gates all pass merges exactly as before (regression)
