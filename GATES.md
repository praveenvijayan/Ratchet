<!--
GATES.md — the project config you hand-author (the memory/ files are the other
project-specific files, but those are agent-generated). It holds the verification
gates the agent runs before opening a PR. /ratchet-init fills this in by
detecting your stack; edit it freely. Ratchet updates never overwrite this file.

Rules: run in order, fail-fast (stop at the first failure). A gate with no
command for your project should read `TODO: <gate> command`, not a guess.
-->

# Gates

Run in order, fail-fast. Replace the commands with your stack's equivalents
(or let `/ratchet-init` detect them).

<!-- auto-detected by /ratchet-init on 2026-07-08; verify before first run.
     This repo is the Ratchet framework itself: markdown + zero-dependency
     Node scripts, no package manifest — only the compiler test is evidenced. -->

| Order | Gate      | Command                          | Pass condition |
|-------|-----------|----------------------------------|----------------|
| 1     | format    | TODO: format command             | —              |
| 2     | typecheck | TODO: typecheck command          | —              |
| 3     | lint      | TODO: lint command               | —              |
| 4     | test      | `node scripts/plan-sync.test.mjs` | exit 0        |
| 4b    | test      | `node scripts/plan-sync-concurrency.test.mjs` | exit 0 |
| 5     | build     | TODO: build command              | —              |
