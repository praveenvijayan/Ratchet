---
title: Compress AGENTS.md into an always-loaded safety kernel
priority: medium
labels: [docs, agents]
blocked_by: [0144-ratchet-start-script, 0145-ratchet-requeue-heartbeat-scripts, 0146-ratchet-submit-script, 0147-ratchet-hotfix-skill, 0148-skill-detail-extraction]
---

Rewrite `AGENTS.md` itself as a compact always-loaded safety kernel: every
invariant an agent must know before it can decide what to load next, plus a
routing table, plus one-command references to the deterministic scripts. All
procedures and explanations defer to skills, scripts, `DOCS.md`, and
`plan/README.md`. Governing principle: defer procedures and explanations;
never defer authority, ownership, scope, or safety invariants. The blockers
guarantee every artifact the kernel references ships before the kernel does,
so a release never points at missing scripts or skills.

## Acceptance criteria
- [ ] `AGENTS.md` retains, in normative form: the eight-plus-zero hard rules; claim-before-any-local-work ordering; worktree-only attachment with the shared clone parked on `main`; `--ff-only` integration; ownership proof and explicit-handoff rules; the scope cap with split-and-requeue; one-test-per-criterion with `## Test notes`/`## Non-functional` coverage; the error-path completion rule; the heartbeat lease requirement; the label state machine; the memory-files read rule with `USER.md` never edited; and the hotfix lane's explicit-human-trigger-only prohibition
- [ ] A routing table routes every deferred concern by reading a file path (for example `.agents/skills/ratchet-status/SKILL.md`) rather than by skill invocation, and every routed path exists in the repository
- [ ] Claim, requeue, heartbeat, and handoff appear as single `node scripts/ratchet-*.mjs` commands with their exit-code meanings, and the multi-step shell recipes they replace are gone from the manual
- [ ] Each hard rule in the kernel carries a machine-readable marker of the form `<!-- ratchet:invariant:<id> -->` for the protocol-coverage gate (0149-protocol-coverage-gate)
- [ ] An automated comparison against the pre-change `AGENTS.md` reports byte and token reductions and fails unless both are at least 40 percent
- [ ] An automated parity check verifies the kernel still names the required commands, state and priority labels, branch patterns, heartbeat marker, ownership marker, and safety prohibitions
- [ ] The existing documentation gates (`docs-refresh`, `state-instructions-symmetry`) pass against the rewritten manual
- [ ] Every criterion above has exactly one test named after it

## Notes
Supersedes the earlier evaluation-artifact scope of this plan (a parallel
`AGENT_SOL_SLIM.md`): the evaluation was performed, the compressed form is
adopted directly. No parallel manual file is added; the repository keeps a
single agent manual. Prefer compact normative statements over narrative; keep
one authoritative statement per rule and cross-reference it.
