---
title: Every acceptance criterion must state how an agent proves it, with human-only checks split into a runbook section
priority: high
labels: [planning, docs]
blocked_by: []
---

Roughly 15 PRs "passed" criteria with pseudo-tests (source-string assertions
instead of behavior tests) because plans never said what counts as proof, and
criteria an agent cannot verify ("sign-in works on staging") either stalled or
were waved through. The #289 fix — rewriting the human-only check as an
explicit runbook item — was correct; make it the rule.

## Acceptance criteria
- [ ] `plan/README.md` documents the verifiability rule: every criterion must be provable by the building agent via a named mechanism — a test, a command, or an observable check — with a before/after rewrite example of an unverifiable criterion
- [ ] `plan/README.md` documents an optional `## Human runbook` section (plain `-` bullets, never `- [ ]`) for checks only a human can perform; the sync carries it into the issue verbatim like the other optional sections
- [ ] `plan/README.md` states that UI/behavior criteria require behavior tests and that tests asserting on source strings do not satisfy a criterion
- [ ] AGENTS.md's review step instructs the reviewer to reject a PR whose criterion-mapped test asserts on source text instead of behavior
- [ ] A plan file without the new section compiles and syncs exactly as before (regression)
