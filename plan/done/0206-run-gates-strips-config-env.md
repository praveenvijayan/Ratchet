---
title: run-gates strips gate-config env at the spawn, so no suite can inherit CI's config
priority: high
labels: [scripts, gates]
blocked_by: []
estimated_lines: 120
---

Root-cause follow-up to the hotfix on PR #492, which stopped the bleeding but
did not remove the trap. The `pr-gates` job sets `BASE_GATES_FILE` on the step
that runs `run-gates.mjs` (the #84 trust boundary, PR #97). `run-gates.mjs`
spawns every gate suite with the ambient environment, so each child inherits it —
and both `pr-size-check.mjs` and `run-gates.mjs` resolve
`CONFIG_FILE = BASE_GATES_FILE || GATES_FILE`, which means the leaked real
config **outranks the fixture every test carefully wrote**.

Two suites were already caught by it, in CI only: `pr-size-check.test.mjs`
inverted its configurable-threshold cases, and `run-gates.test.mjs` recursed
until timeout because a spawned runner read the real gate table including its own
`test: run-gates` row. The hotfix stripped the variable in those two files. That
is per-suite discipline nobody will remember: the next suite that spawns a child
with `...process.env` re-opens the same hole, and it fails **only in CI**, where
it is most expensive to diagnose.

The durable fix is to strip gate-config variables once, at the single point where
children are created — `run-gates.mjs` — so a suite cannot inherit them at all.
`run-gates` keeps reading the base copy itself; only what it hands to children
changes.

## Acceptance criteria
- [ ] `run-gates.mjs` removes `BASE_GATES_FILE` and `GATES_FILE` from the environment of every gate command it spawns; proven by a fixture gate command that prints both variables and asserts the child saw neither, while the existing #84 base-vs-head test still shows the runner itself judging by the base copy
- [ ] A gate run under a CI-like environment uses its own fixture table and terminates; proven by a test that runs `run-gates.mjs` with `BASE_GATES_FILE` pointing at a copy of the real `GATES.md` and a two-row fixture `GATES_FILE`, asserting exactly the two fixture gates ran and the process exited (no recursion)
- [ ] The per-suite strips the hotfix added to `pr-size-check.test.mjs` and `run-gates.test.mjs` are no longer load-bearing; proven by both suites passing with `BASE_GATES_FILE` set in the ambient environment after the strip lines are removed from each
- [ ] `DOCS.md` states that `run-gates.mjs` owns the gate-config trust boundary and that no gate suite may read gate config from the ambient environment; proven by an assertion in `docs-refresh.test.mjs`

## Test notes
- Exercise the child-environment assertion through a real spawned gate command, not by inspecting `run-gates.mjs` source text — asserting the source mentions a variable name proves text exists, never that the child was cleaned.
- The CI-like run must assert the process terminates. The failure this plan exists to prevent is a hang, and a suite that hangs reports nothing at all.

## Non-functional
- The CI-like regression must not re-run the real gate table; it uses a two-row fixture so the guard costs seconds, not a second full suite run.
