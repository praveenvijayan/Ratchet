---
title: herd-ui.test.mjs must not read an archivable plan file at runtime
priority: high
labels: [herd]
blocked_by: []
---

`scripts/herd-ui.test.mjs` reads `plan/0069-herd-web-dashboard.md` at runtime
for its "one test per criterion" self-count. When issue #144 closed,
`archive-closed-plans` removed that plan file (commit `e3394ea`), so the test
now throws `ENOENT` and the `test: herd-ui` gate is red on `main` — which
fails `run-gates` and the `pr-gates` CI check for **every** agent PR, jamming
the whole delivery loop. The self-count should be derived from the test file
itself (its own `Criterion N` markers), which cannot be archived away, exactly
as `herd-avatar.test.mjs` already does. Any other test that reads a closable
issue's `plan/NNNN-*.md` at runtime has the same latent failure and must be
audited.

## Acceptance criteria
- [ ] `node scripts/herd-ui.test.mjs` exits 0 with the repository in its current state (the `plan/0069-*.md` file archived/absent), and the `test: herd-ui` gate passes under `run-gates`
- [ ] `herd-ui.test.mjs`'s per-criterion self-count is derived from its own `Criterion N` markers and reads no `plan/NNNN-*.md` file at runtime, so archiving the plan when the issue closes can never break it
- [ ] No `scripts/*.test.mjs` reads a closable issue's `plan/NNNN-*.md` at runtime for a pass/fail assertion; reading `plan/README.md` or a purpose-built fixture is fine, and any offender is converted to a self-contained check
- [ ] Every criterion above has exactly one test named after it

## Test notes
- Regression guard: a check (in `herd-ui.test.mjs` or `docs-refresh`/`gates-coverage`-style meta-test) that greps the `scripts/*.test.mjs` sources and fails if any of them reference a `plan/[0-9]{4}-` path at runtime, so this coupling cannot be reintroduced.
