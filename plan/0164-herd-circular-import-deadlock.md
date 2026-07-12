---
title: Fix herd supervisor ESM circular-import deadlock (exit 13, nothing runs)
priority: high
labels: [scripts, herd]
blocked_by: []
---

`node scripts/herd.mjs` (any mode, including the run loop the dashboard
depends on) dies before executing a single command: Node prints
`Warning: Detected unsettled top-level await` at the
`await import("./herd-dispatch.mjs")` line and exits with code 13. The whole
herd supervisor is unusable, so the dashboard shows nothing.

## Acceptance criteria
- [ ] `node scripts/herd.mjs --dry-run --once` completes without the `Detected unsettled top-level await` warning and without exit code 13
- [ ] Every herd subcommand entry path loads its profile modules successfully (no unsettled top-level await on any of the dynamic imports in the `isMain` block)
- [ ] On a core-only install with the `herd` profile absent, the supervisor still prints the existing bootstrap install hint and exits 1 (the missing-profile guard survives the fix)
- [ ] A regression test fails if any module dynamically imported by the herd.mjs `isMain` block statically imports (directly or transitively) from `herd.mjs` again
- [ ] Every criterion above has exactly one test named after it

## Notes
Cycle introduced in 92e1d2f: `herd-dispatch.mjs` statically imports
`resolveAdapter`/`substitute`/`extractUsage` from `herd.mjs`, while
`herd.mjs` top-level-awaits `import("./herd-dispatch.mjs")` inside its
`isMain` block. ESM cannot finish evaluating either module, Node detects the
unsettled top-level await and kills the process (exit 13). Reproduced on
current `main`.
