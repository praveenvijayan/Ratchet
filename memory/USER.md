<!--
USER.md — human-owned memory. The agent READS this at the start of every issue
and NEVER edits it. Put stable, settled facts here: team preferences, coding
conventions, domain glossary, and "always X / never Y" rules. Keep it short and
current; delete anything no longer true.
-->

# Project preferences & conventions

## Coding conventions
- (e.g.) TypeScript strict mode; no `any`. Prefer composition over inheritance.
- (e.g.) Conventional Commits for all commit messages.

## Review preferences
- (e.g.) Small PRs only; one issue per PR. Tests required for new behaviour.

## Tech decisions (settled)
- (e.g.) State management: XState. HTTP: native fetch, no axios.

## Always / never
- Always: (e.g.) add a failing test before implementing a bug fix.
- Never: (e.g.) introduce a new dependency without noting why in the PR.

## Glossary
- (term) — (one-line definition)
