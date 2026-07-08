---
title: Parse GATES.md rows with pipes in commands correctly
priority: medium
blocked_by: []
---

`run-gates.mjs` splits table rows on every `|`, including inside backtick code
spans, and has no `\|` escape handling. A gate command containing a pipe (e.g.
`npm test | tee log`) is silently truncated to its prefix — which runs, and can
pass a gate whose real command would fail. A gate runner must never execute
something other than what the table says.

## Acceptance criteria
- [ ] A gate command containing `|` inside backticks runs in full
- [ ] A row the parser cannot interpret unambiguously fails the run with a message naming the row — a truncated command prefix is never executed
