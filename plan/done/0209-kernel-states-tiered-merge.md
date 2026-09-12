---
title: The kernel and the human-facing docs state the tiered merge — "human merge" is no longer the whole truth
priority: high
labels: [docs]
blocked_by: [0201-tiered-review-automerge]
estimated_lines: 110
risk: normal
---

0201 makes the merge tiered: a normal-risk PR merges on green checks plus an
approving recorded verdict, with no human in the path. The always-loaded kernel
still teaches the opposite — `AGENTS.md` writes the loop as
`PR → human merge → unblock dependents` and step 7 opens "A human merges". An
agent that believes the kernel will read its own PR merging with no human as an
anomaly, and a human reading `README.md` or `plan/README.md` learns a review
model the repo no longer runs. Hard Rule 6 is unchanged and must stay unchanged
— the *agent* still never merges — but the kernel must say what the *system*
does, or the two disagree in the one file every agent loads.

`plan/README.md` has the matching gap on the authoring side: it documents that
`risk: high` travels from the plan to the issue label to the PR label, and stops
there. The reason a plan author picks `risk: high` is now the merge consequence
— a human approval plus a hold — and that is exactly what the file omits.

## Acceptance criteria
- [ ] `AGENTS.md`'s loop line and step 7 describe the tiered merge — a normal-risk PR merges on green checks plus an approving verdict, a `risk:high` PR waits for a human — instead of an unconditional "human merge" (test: "the kernel states the tiered merge", in `scripts/agents-kernel.test.mjs`)
- [ ] `AGENTS.md` Hard Rule 6 still forbids the agent from merging, approving, closing, or touching `main`, and additionally tells the agent that a PR merged by the `auto-merge` workflow is normal, not an anomaly to investigate (test: "Hard Rule 6 keeps the agent ban and names the system merge")
- [ ] `plan/README.md` documents what `risk: high` costs at merge time — a human approval and the minimum hold — next to where it documents the label inheritance (test: "the plan format documents the risk tier's merge consequence")
- [ ] `README.md`'s description of the loop no longer tells a reader that every PR waits on a human merge (test: "the README loop matches the tiered merge")
- [ ] Every criterion above has exactly one test named after it
