---
title: A gate suite may not depend on a developer's machine — prove it with an agent-CLI-free run
priority: high
labels: [scripts, gates]
blocked_by: []
estimated_lines: 140
---

Root-cause follow-up to hotfix PR #495. Three herd suites named the real
`claude` CLI as their adapter launch binary. `herd-adapters.mjs` probes that
binary with `accessSync(p, X_OK)` before a route resolves, so the suites passed
on every machine with Claude Code installed — which is every machine that could
have written them — and failed on every CI runner, where dispatch never happened
and the events they assert on were never produced.

The hotfix corrected the three fixtures. It did not stop the fourth. Nothing
prevents the next suite from reaching for a binary that happens to be installed
locally, and the failure surfaces only in CI, where it is most expensive to read.

This is the third CI-only red in one day, each masked by the one before it
(`BASE_GATES_FILE` leak → PR #492 and plan 0206; this one → PR #495). The
pattern is the same both times: **the gate run's environment differs from the
developer's, and nothing measures the difference.** The durable fix is to make
that difference something the suite itself asserts, locally, before CI sees it.

## Acceptance criteria
- [ ] A gate proves the suite passes with no agent CLI installed: it runs the gate commands with a `PATH` that carries the toolchain (`node`, `git`, `gh`) but no adapter binary from the shipped `defaultConfig()`, and exits non-zero naming any suite that fails only under it — proven by a test that injects a fixture suite depending on a stubbed binary and asserts the gate reports that suite by name
- [ ] The guard resolves the binaries to hide from the shipped adapter config, not from a hardcoded list, so adding an adapter to `herd.mjs` extends the guard with no second edit — proven by a test that adds an adapter to a fixture config and asserts its binary is among those hidden
- [ ] A suite that legitimately needs a real binary can declare so and is skipped by the guard rather than failing it; the declaration is visible in the suite, not in the guard — proven by a test with a declared suite passing and an undeclared one failing
- [ ] `GATES.md` runs the guard as its own row, and `DOCS.md` states that a gate suite may not depend on a binary outside the toolchain — proven by the `gates-coverage` gate finding the row and an assertion in `docs-refresh.test.mjs`

## Test notes
- Exercise the guard by running it against fixture suites in a temp dir, never by grepping the repo's real suites — a guard asserted against today's suites proves nothing about tomorrow's.
- One test must cover the masking case: two fixture suites both failing, with the guard naming both rather than stopping at the first. Every incident in this chain was made expensive by fail-fast hiding the next failure.

## Non-functional
- The guard must not re-run the full gate table under a second environment. It runs only the suites, once, with the modified `PATH` — the cost is one extra suite pass, not a doubled CI run.
