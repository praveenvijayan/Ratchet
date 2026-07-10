---
title: Herd reacts to PR review verdicts — changes-requested triggers rework and label updates
priority: high
labels: [herd]
blocked_by: []
---

A Request Changes review on a herd worker's PR does nothing: `ready-for-review`
is a terminal status the monitor never revisits, no herd component polls the
PR's review decision, and no workflow listens to `pull_request_review`. AGENTS.md
step 6 assigns the rework reaction (including flipping the issue to
`state:changes-requested`) to the agent — but the herd worker exited at PR-open,
so nobody reacts. Observed on PR #188 / issue #165: review submitted
CHANGES_REQUESTED, label stuck at `state:in-review`, no rework dispatched. The
review loop — the core of the whole flow — is open-circuit in herd mode.

## Acceptance criteria
- [ ] A tracked open PR whose review decision becomes CHANGES_REQUESTED moves its issue label from `state:in-review` to `state:changes-requested` on the next poll
- [ ] The same detection dispatches a rework worker on the issue's existing branch, and the worker's prompt directs it to the PR's review feedback
- [ ] The rework dispatch counts against `reworkCap`; at the cap the issue is escalated instead of re-dispatched, naming the PR and the cap
- [ ] After the rework worker pushes and the PR updates, the issue label returns to `state:in-review`
- [ ] An APPROVED review dispatches nothing and changes no labels — merging stays human-only
- [ ] A changes-requested PR already being reworked (live worker on the entry) is not dispatched again on subsequent polls
- [ ] A transient failure reading the review decision leaves the entry untouched and is retried next poll, never misread as a verdict
- [ ] Every criterion above has exactly one test named after it

## Notes
Verified before planning: `TERMINAL_STATUS` includes `ready-for-review`
(scripts/herd-monitor.mjs), zero references to `reviewDecision`/
`CHANGES_REQUESTED` in the herd scripts, and no `pull_request_review` trigger in
any workflow. `ratchet-watch.mjs` is the chat-mode webhook helper (signals a
human to run /ratchet-next) and is not wired into the herd. `sweep-stale-claims`
already reclaims abandoned `state:changes-requested` work, so the label flip
composes with the existing recovery path.

One rework engine, two triggers: the rework behaviour itself (same branch, same
PR, reply to comments, label back to `state:in-review`) is AGENTS.md step 6 and
stays agent-side — the dispatched rework worker executes it exactly as a chat
agent does when a human runs /ratchet-next. The supervisor adds only detection
and dispatch (the role the human plays in chat mode), never a second rework
implementation. The chat flow is unchanged by this issue. The supervisor's
label flip at detection time is deliberate minimal redundancy with the worker's
own step-6 flip: idempotent, and it keeps the label truthful when the rework
dispatch itself fails.
