---
title: Size gate counts hand-written lines only — generated files excluded by default
priority: low
labels: [scripts, gates]
blocked_by: []
---

The size gate's count includes generated artifacts (lockfiles, schema
snapshots, install manifests), which gives every over-cap PR a standing excuse
and turns the gate into negotiation prose. The gate already reads excludes from
base-branch config (0041); what's missing is a sensible generic default set and
the documented rule that the cap measures hand-written lines only.

## Acceptance criteria
- [ ] The default exclude set covers common generated files (lockfiles such as `package-lock.json`/`pnpm-lock.yaml`/`yarn.lock`, snapshot directories, install manifests) without any host configuration
- [ ] Host-configured excludes extend the defaults rather than replace them, and a host can still opt out of a specific default explicitly
- [ ] The gate's output states the hand-written line count and lists which changed files were excluded as generated, so an over-cap verdict is self-explanatory
- [ ] A PR whose hand-written lines exceed the cap fails the gate even when generated files dominate the diff, and vice versa (a PR under the cap plus a large lockfile passes)
