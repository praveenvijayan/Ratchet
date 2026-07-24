---
title: Conditional survey treats HTTP 304 as success instead of a gh failure
priority: medium
labels: [scripts, herd]
blocked_by: []
---

The conditional-survey fast path (0174) never succeeds against the live API.
`gh api` exits non-zero on any non-2xx response — including `304 Not Modified`,
the very outcome the ETag probe exists to receive. `ghConditional` awaits the
exec before parsing the status line, so the promise rejects on every 304,
`surveyConditional` catches it as a failure, drops the whole ETag cache, and
falls back to a full unconditional survey. Observed in a live run: every
unchanged tick logs `conditional survey failed (... gh: HTTP 304); falling back
to a full survey`. Net effect is worse than having no ETag support at all —
each cycle pays the full survey plus one wasted conditional request, and the
lowered default tick (0175) multiplies the waste.

## Acceptance criteria
- [ ] A conditional probe whose endpoint answers `304 Not Modified` resolves as `{ status: 304 }` with the cached entry retained — it is not treated as a `gh` failure, even when the `gh` process exits non-zero
- [ ] A tick where every endpoint answers 304 completes on the fast path: no `survey-fallback` event is logged, the ETag cache is unchanged, and no full survey runs
- [ ] A genuine `gh` failure (network error, 5xx, unparseable output) still falls back to the unconditional full survey with a `survey-fallback` herd event — never a crash, never a silently skipped pass
- [ ] A 304 on an early endpoint does not abort the tick's remaining endpoint probes
- [ ] Every criterion above has exactly one test named after it

## Non-functional
- Zero npm dependencies; Node 20+. All tests run offline through the injected
  conditional-caller boundary; the live `gh` behaviour (non-zero exit on 304
  with headers still on stdout) is documented at the boundary.

## Notes
Diagnosed cause: `pexec` throws on `gh`'s non-zero exit before the status-line
parser in `ghConditional` runs, so the 304 branch in `surveyConditional` is
unreachable on the live boundary (only injected test callers ever reach it).
With `--include`, `gh` still prints the response headers on stdout when it
exits non-zero.
