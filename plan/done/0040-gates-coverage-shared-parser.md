---
title: Make gates-coverage share run-gates' row parser and skip TODO rows
priority: medium
blocked_by: []
---

`gates-coverage.mjs` still splits table rows on every `|` while `run-gates.mjs`
gained a backtick/escape-aware parser — the two now disagree about what a row
means. Demonstrated holes: a suite mentioned only inside a `TODO:` command
counts as "covered" though run-gates never executes it (green guard, suite runs
nowhere), and a legal backticked pipe command with the suite filename after the
pipe false-fails the guard.

## Acceptance criteria
- [ ] gates-coverage parses GATES.md rows with the same parser run-gates executes them with (one shared definition, not a copy)
- [ ] A test file mentioned only in a `TODO:` command is reported as uncovered
- [ ] A backticked gate command containing a pipe, with the suite filename after the pipe, counts as covered without a false failure
