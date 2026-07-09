---
title: Fix stale-sweep measuring freshness from the branch tip instead of the claim
priority: high
blocked_by: []
---

`sweep-stale-claims` measures staleness from the claim branch's tip commit date.
A fresh claim ref points at `main` HEAD, and agents don't push commits until
gates pass — so on any repo where `main` is quiet for more than `STALE_HOURS`,
every new claim looks stale within one sweep tick: the ref is deleted and the
issue re-queued while the claiming agent is still building locally. This breaks
the atomicity the claim design exists to provide.

## Acceptance criteria
- [ ] A claim created within `STALE_HOURS` whose branch has zero commits beyond `main` is never swept, regardless of how old `main`'s last commit is
- [ ] For zero-commit claims, staleness is measured from the claim event (the `state:in-progress` labeled-event timestamp on the issue timeline), falling back to the issue's `updated_at` when no such event exists
- [ ] For branches with commits ahead of `main`, staleness continues to be measured from the branch's last commit date
- [ ] The sweep comment names which timestamp source was used (claim event vs last commit), so a wrong sweep is diagnosable instead of silent
