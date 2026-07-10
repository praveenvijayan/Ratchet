---
title: Fall back to the next available herd adapter when the preferred one is unavailable
priority: medium
labels: [herd]
blocked_by: []
---

Routing today resolves an issue to a single adapter name (`routing.default` or a
`routing.labels` value) with no notion of availability: if that adapter's CLI is
not installed or its API key is unset, the herd spawns a worker that cannot run
and only discovers the failure at the claim timeout. To let a project say "use
claude, else codex, else pi", a route may be an ordered list and the dispatcher
picks the first adapter that is actually available — the generic, adapter-neutral
mechanism that any fallback (including Pi via OpenRouter) rides on.

## Acceptance criteria
- [ ] A routing entry (`routing.default` or any `routing.labels` value) may be either an adapter name or a non-empty ordered array of adapter names; a name that is not a defined adapter exits nonzero naming the offending entry and name
- [ ] An adapter may declare `requiresEnv: ["VAR", ...]`; an adapter whose launch executable does not resolve on `PATH`, or any of whose `requiresEnv` vars is unset or empty, is treated as unavailable
- [ ] `resolveAdapter` returns the first adapter in the resolved route that is available; a string entry behaves as a one-element list so existing configs with a present binary dispatch unchanged
- [ ] When no adapter in a route is available, the issue is not dispatched and an escalation names the route and every adapter tried, each with why it was unavailable (missing binary vs unset env var)
- [ ] The framework purity test still passes — the availability and fallback logic references no specific CLI, model, or env-var name
- [ ] Every criterion above has exactly one test named after it

## Notes
Availability is defined deterministically so it is testable offline: launch
executable resolvable on `PATH` **and** every declared `requiresEnv` non-empty.
This keeps the framework pure (0051) — `requiresEnv` and the fallback list are
generic config the loader validates, never adapter-specific logic.
