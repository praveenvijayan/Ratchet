---
title: Document a Pi/OpenRouter herd adapter as a claude→codex fallback
priority: medium
labels: [herd]
blocked_by: [0071-herd-adapter-fallback-routing]
---

Pi needs no framework code — herd adapters are pure config (0051). What is
missing is a worked, correct way to run Pi against OpenRouter as an adapter and
to wire it as the fallback when claude and codex are unavailable, using the
availability/fallback mechanism from 0071. This issue supplies that adapter
recipe and its fallback wiring in the herd documentation, verified end to end
against a stub Pi CLI.

## Acceptance criteria
- [ ] The herd documentation gains a copy-ready `pi` adapter block that runs Pi against OpenRouter and declares `requiresEnv: ["OPENROUTER_API_KEY"]`, alongside a `routing.default` example of the ordered chain claude → codex → pi
- [ ] With `OPENROUTER_API_KEY` unset, a claude→codex→pi route treats pi as unavailable and dispatches no pi worker (exercised against a stub pi CLI)
- [ ] With the claude and codex executables absent from `PATH` and `OPENROUTER_API_KEY` set, the same route dispatches the pi worker
- [ ] The framework purity test still passes — `scripts/herd.mjs` logic names no `pi` or `openrouter` string; they appear only in config examples and docs
- [ ] Every criterion above has exactly one test named after it

## Notes
Pi via OpenRouter is an API-key adapter, so its availability hinges on
`OPENROUTER_API_KEY` — exactly the `requiresEnv` gate 0071 introduces, which is
why this is blocked on it. Exact Pi CLI argv is left to the implementing agent
(and to Pi's own docs); the criteria fix behaviour, not the flags.
