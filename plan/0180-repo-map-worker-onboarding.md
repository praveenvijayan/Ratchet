---
title: Ship a generated MAP.md workers read before exploring the codebase
priority: medium
labels: [docs, agents]
blocked_by: []
---

Workers burn their earliest turns grep-crawling the repo to orient — measured
spawn-to-claim ranged 23–122s and exploration dominates the early transcript.
The `ratchet-map` skill already generates a repo map; check the generated
`MAP.md` into the repo and make the worker contract read it first, so one file
read replaces an exploration crawl.

## Acceptance criteria
- [ ] A generated `MAP.md` exists at the repo root, carrying its generation date and the one-line instruction for regenerating it (the `ratchet-map` skill)
- [ ] The AGENTS.md kernel directs agents to read `MAP.md` (when present) before exploring the codebase, and the existing docs/parity gates pass
- [ ] An automated staleness check fails when a path listed in `MAP.md` no longer exists in the repo, naming the stale entries
- [ ] A repo without a `MAP.md` behaves exactly as today — the contract wording and the staleness check both tolerate its absence
- [ ] Every criterion above has exactly one test named after it

## Non-functional
- Record before/after spawn-to-claim timings from a demo-repo herd run in the PR description, so the cold-start gain is documented rather than assumed.
