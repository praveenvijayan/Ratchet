---
title: Fix herd supervisor ESM circular-import deadlock (exit 13, nothing runs)
priority: high
labels: [scripts, herd]
blocked_by: [0165-herd-adapter-leaf-module]
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
Root cause is the whole strongly-connected import component, not just
dispatch: `herd.mjs`'s `isMain` block top-level-awaits dynamic `import()` of
the profile modules, and ESM cannot settle any of those imports until the
entire cycle finishes evaluating. All four profile modules import back from
`herd.mjs` — `herd-dispatch.mjs` (`resolveAdapter`/`substitute`/
`extractUsage`, deadlocks first at line 691) and `herd-monitor.mjs`/
`herd-verify.mjs`/`herd-review.mjs` (`substitute`), each of which would
deadlock in turn. Node detects the unsettled top-level await and kills the
process (exit 13). Reproduced on current `main`.

Second slice of a two-PR split (file-cap): 0165-herd-adapter-leaf-module
extracts the helpers into a leaf module first; this issue repoints all four
profile modules to it and adds the cycle regression test. The `herd.mjs`
re-exports added in 0165 stay — `herd.test.mjs` imports the three names from
`herd.mjs`, and a re-export toward a leaf module is acyclic, so removing it
buys nothing and would push this PR over the file cap.
