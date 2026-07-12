---
title: Add a slim LLM-optimized agent operating manual
priority: medium
labels: [docs, agents]
blocked_by: []
---

Create `AGENT_SOL_SLIM.md` beside `AGENTS.md` as a substantially smaller,
LLM-oriented version of the operating manual. Preserve the protocol's
behavioral contract while removing repetition and moving human-oriented
explanation out of the agent prompt where `README.md` or `DOCS.md` already
covers it. This is an evaluation artifact only: the active `AGENTS.md` remains
unchanged until a human compares the two.

## Acceptance criteria
- [ ] `AGENT_SOL_SLIM.md` is created in the repository root and `AGENTS.md` is byte-for-byte unchanged by the PR
- [ ] The slim manual preserves every workflow phase and operational path in `AGENTS.md`: plan, pick, atomic claim and ownership/resume, build and heartbeat, verification, PR handoff, rework, system closeout, memory, continuous operation, and the explicit hotfix/revert exception
- [ ] The slim manual preserves all mandatory invariants, including the eight numbered hard rules, branch/worktree discipline, state and priority labels, scope and test constraints, error-path requirements, gate ordering and retry behavior, and terminal stop conditions
- [ ] Content omitted as human-facing or redundant is validated against `README.md` and `DOCS.md`, and the slim manual retains concise pointers for any external detail an agent still needs to locate
- [ ] The slim manual is materially smaller than `AGENTS.md`, with an automated comparison reporting byte and token-count reductions and failing unless both are at least 40 percent
- [ ] An automated parity check verifies the required sections, commands, state labels, branch patterns, heartbeat marker, ownership marker, and safety prohibitions are present in the slim manual
- [ ] Every criterion above has exactly one test named after it

## Notes
Optimize for deterministic LLM execution: prefer compact normative statements,
tables, and pseudocode over narrative explanation. Do not weaken a repeated rule
merely because its prose is consolidated; preserve one authoritative statement
and cross-reference it where needed.
