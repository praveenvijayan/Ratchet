---
title: Herd survey uses conditional GitHub requests so unchanged ticks cost no rate limit
priority: medium
labels: [scripts, herd]
blocked_by: []
---

Every survey tick pays full GitHub API cost even when nothing upstream changed.
GitHub honors `ETag`/`If-None-Match`, and a `304 Not Modified` does not count
against the REST rate limit. The survey layer (`herd-survey.mjs`, via the
injected `gh`) should send conditional requests with per-endpoint ETags cached
in memory for the supervisor process, and skip the downstream survey/verify/
review pass when nothing changed. This makes a much shorter poll tick
affordable (follow-up plan lowers the default).

## Acceptance criteria
- [ ] Survey requests for each polled endpoint (issues by label, open PRs) send `If-None-Match` with the ETag stored from that endpoint's previous response; the first request per endpoint is unconditional and stores the returned ETag
- [ ] When every polled endpoint returns 304, the tick skips the downstream survey/verify/review pass and mutates no state
- [ ] When any endpoint returns 200, the full normal pass runs and that endpoint's stored ETag is replaced with the new one
- [ ] A response with no ETag header, or a `gh` failure, falls back to the unconditional full pass with the failure logged as a herd event — never a crash, never a silently skipped pass
- [ ] Every criterion above has exactly one test named after it

## Non-functional
- Zero npm dependencies; Node 20+. ETag handling reaches GitHub only through the injected `gh` boundary so all tests run offline with no network.
- 304 short-circuiting changes *when* the existing passes run, never *what* they do; supervisor authority and pidfile semantics unchanged.

## Notes
ETag cache is in-memory per supervisor process — no persistence across
restarts (first tick after restart is simply unconditional). Non-goals: no
webhooks, tunnels, or Actions relays; the default `pollSeconds` is lowered in
a separate follow-up plan blocked on this one.
