---
title: Default herd adapters must let a headless worker claim without a permission prompt
priority: high
labels: [herd]
blocked_by: []
---

The default `claude` and `codex` adapter `launch` argv the herd writes
(`scripts/herd.mjs` init defaults) run the agent CLI headless but with no flag
that bypasses interactive permission prompts. The claim step touches the git
directory to push the `agent/issue-<N>` ref, which the agent CLI guards as a
sensitive operation; headless with no bypass, the worker stalls on a prompt it
cannot answer, never creates the claim ref, is killed at `claimTimeoutSeconds`,
and is marked `dispatch-failed`. Every dispatch on such an adapter dies the same
way. New projects must dispatch a claimable worker out of the box, and existing
projects whose config predates the fix must get a clear signal to update.

## Acceptance criteria
- [ ] `node scripts/herd.mjs init` writes a default `.ratchet/herd.json` whose `claude` adapter `launch` array contains `--dangerously-skip-permissions`
- [ ] The same default `codex` adapter `launch` array contains codex's documented non-interactive approval-bypass flag so a headless codex worker never blocks on an approval prompt
- [ ] Loading a config whose `claude` or `codex` adapter `launch` omits its known headless-permission flag prints a one-line `WARNING` naming the adapter and the missing flag, and continues (exit zero) — a custom or intentionally-interactive launch is never a hard failure
- [ ] The warning is silent for any adapter that is not `claude` or `codex`, and for a `claude`/`codex` adapter whose launch already carries the flag
- [ ] Every criterion above has exactly one test named after it

## Notes
Observed dogfooding: dispatches on the `claude` adapter (#81, #82, #83, #122,
#125, #140, #175) all died `dispatch-failed` after the worker logged
`"Claude requested permissions to edit .git/… which is a sensitive file"` and
never pushed `agent/issue-<N>`. The launch argv in that project's
`.ratchet/herd.json` was `["claude","-p","--verbose","--output-format",
"stream-json","{prompt}"]` — no `--dangerously-skip-permissions`. The bypass
flag is appropriate here by definition: a herd worker is non-interactive, so
there is no operator to answer the prompt. `init` refuses to overwrite an
existing file, so shipping the flag in the default only fixes new projects — the
load-time warning is what tells an existing project to add it.
