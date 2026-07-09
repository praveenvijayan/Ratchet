---
title: Document an opencode/OpenRouter herd adapter as a claude→codex fallback
priority: medium
labels: [herd]
blocked_by: [0071-herd-adapter-fallback-routing]
---

opencode needs no framework code — herd adapters are pure config (0051). What is
missing is a worked, correct way to run opencode headless against OpenRouter as
an adapter and to wire it as the fallback when claude and codex are unavailable,
using the availability/fallback mechanism from 0071. opencode is the chosen
fallback because it gives the worker first-class terminal, filesystem, git, and
tool access — the surface an agent needs to follow AGENTS.md's claim → worktree →
test → PR protocol end to end. This issue supplies that adapter recipe and its
fallback wiring in the herd documentation, verified against a stub opencode CLI.

## Acceptance criteria
- [ ] The herd documentation gains a copy-ready `opencode` adapter block that runs opencode headless (non-interactive) against OpenRouter and declares `requiresEnv: ["OPENROUTER_API_KEY"]`, alongside a `routing.default` example of the ordered chain claude → codex → opencode
- [ ] The documented opencode launch runs fully non-interactive — it never blocks on an approval or permission prompt for git/shell/filesystem actions (the headless-claim failure mode of 0070), and the docs call this out
- [ ] With `OPENROUTER_API_KEY` unset, a claude→codex→opencode route treats opencode as unavailable and dispatches no opencode worker (exercised against a stub opencode CLI)
- [ ] With the claude and codex executables absent from `PATH` and `OPENROUTER_API_KEY` set, the same route dispatches the opencode worker
- [ ] The framework purity test still passes — `scripts/herd.mjs` logic names no `opencode` or `openrouter` string; they appear only in config examples and docs
- [ ] Every criterion above has exactly one test named after it

## Notes
opencode via OpenRouter is an API-key adapter, so its availability hinges on
`OPENROUTER_API_KEY` — exactly the `requiresEnv` gate 0071 introduces, which is
why this is blocked on it. Exact opencode CLI argv (the headless `run`
invocation and its non-interactive flags) is left to the implementing agent and
to opencode's own docs; the criteria fix behaviour, not the flags. Pin a capable
model via 0073's `{model}` — a weak OpenRouter model will not drive the full
AGENTS.md protocol reliably. (This plan was retargeted from an earlier "Pi"
fallback; the filename slug is frozen to keep the issue's identity.)
