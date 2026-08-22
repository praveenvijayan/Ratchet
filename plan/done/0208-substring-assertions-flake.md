---
title: A negative assertion may not match a bare substring of whole-process output
priority: medium
labels: [scripts, gates]
blocked_by: []
estimated_lines: 90
---

`run-gates.test.mjs` (#49 AC2b) proves a truncated gate command never ran by
asserting the run's output does not contain `"42"` — the value the truncated
prefix would print. The output it searches is the child's whole stdout plus
stderr, which embeds a `mkdtemp` path twice, and four times under
`GITHUB_ACTIONS` where the runner also emits `::error::` annotations. Any
incidental `"42"` anywhere in that text fails the assertion.

It fired on PR #491 on 2026-07-25 and passed on an unchanged re-run of the same
commit, having passed on PR #490 at the same base minutes earlier. Local repro
attempts: 0/40 plain, 0/60 under `GITHUB_ACTIONS`, 0/300 against the isolated
case. A test that fails at a rate too low to reproduce and too high to ignore is
worse than no test — it teaches the loop to re-run red until it turns green,
which is the exact habit the required-checks work exists to end.

The assertion's intent is sound; only its evidence is. "The prefix did not run"
should be proven by a marker the prefix alone can produce, in a channel the
runner does not also write to.

## Acceptance criteria
- [ ] The #49 AC2b assertion proves the prefix never ran without substring-matching the whole output: the fixture command's only observable effect is a side effect the runner cannot produce (e.g. a file the prefix would create), and the assertion checks for that effect — proven by a test that makes the runner deliberately execute the prefix and asserts the assertion catches it
- [ ] No test in `scripts/*.test.mjs` asserts absence by matching a bare numeric or short literal against combined stdout+stderr; a guard names each offender with `file:line` — proven by a fixture suite containing such an assertion being reported by the guard
- [ ] The guard distinguishes a bare short literal from an anchored one (a full phrase, or a match tied to a line prefix), so honest negative assertions keep passing — proven by a fixture with an anchored negative assertion not being reported
- [ ] `GATES.md` runs the guard as its own row — proven by the `gates-coverage` gate finding it

## Test notes
- The "make the runner execute the prefix" case must be driven by a fixture runner, not by editing `run-gates.mjs` — the point is that the assertion catches a regression, not that today's runner behaves.

## Non-functional
- The guard is a static read of the test sources; it must not execute any suite, so it costs milliseconds.
