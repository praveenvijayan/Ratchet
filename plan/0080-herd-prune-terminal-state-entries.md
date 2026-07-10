---
title: Prune terminal herd state entries that have no pid and no open PR
priority: high
labels: [herd]
blocked_by: []
---

`dispatch-failed` (and similar terminal) entries carry `pid: null, pr: null`,
so `reconcileState` never flags them (it only looks at dead pids and concluded
PRs) and the monitor skips them as terminal. They sit in the state file
forever: six zombie rows on the dashboard today (#83, #122, #140, #160, #166,
#168), and because dispatch skips any issue present in the state file, the
affected issues can never be re-dispatched. Issue-0065 fixed this for
pr-concluded/dead entries; the no-pid/no-PR terminal case was missed.

## Acceptance criteria
- [ ] A terminal-status entry with no live pid and no open PR is removed from the state file after its escalation has been written
- [ ] An issue whose terminal entry was pruned and which is still `state:ready` is dispatched again on a later poll instead of being skipped
- [ ] An entry with a live worker pid or an open PR is never pruned regardless of status
- [ ] The poll summary line reports how many terminal entries were pruned this pass
- [ ] Every criterion above has exactly one test named after it
