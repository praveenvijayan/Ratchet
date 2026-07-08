#!/usr/bin/env node
// sweep-stale-claims.mjs — the pure decision core of the sweep-stale-claims
// workflow. Given one issue's current state plus the freshness signals already
// fetched from the API, decide whether the sweep returns it to state:ready,
// whether its claim ref should be deleted, and the human-readable comment that
// explains why. Kept out of the workflow YAML so it can be unit-tested without
// the network (see sweep-stale-claims.test.mjs) and so what CI runs and what the
// tests assert can never diverge — the same split unblock-dependents uses for
// scripts/criteria.mjs.
//
// Zero dependencies. Node 20+ (ESM).

// The three lifecycle states the sweep patrols. state:in-progress is the
// original claim lease; in-review and changes-requested close the holes where a
// vanished agent used to strand an issue in a non-terminal state forever.
export const SWEPT_STATES = new Set([
  "state:in-progress",
  "state:in-review",
  "state:changes-requested",
]);

// Decide the sweep's action for one issue. All time inputs are epoch ms.
//   input.state        — the issue's current state:* label (see SWEPT_STATES)
//   input.now          — Date.now()
//   input.staleMs      — the configurable inactivity window, in ms
//   input.staleHours   — the same window as a string, for the comment text
//   input.branch       — agent/issue-<N>, for the comment text
//   input.aheadBy      — commits the claim branch is ahead of main (null if none/absent)
//   input.lastCommitAt — the branch's last-commit time, or null
//   input.claimAt      — most recent state:in-progress labeled-event time, or null
//   input.updatedAt    — issue.updated_at
//   input.hasOpenPr    — an open PR exists from agent/issue-<N> (in-review only)
// Returns { sweep: false } to leave the issue untouched, or
// { sweep: true, deleteRef, comment } to requeue it to state:ready.
export function decideSweep(input) {
  switch (input.state) {
    case "state:in-progress": return decideInProgress(input);
    case "state:in-review": return decideInReview(input);
    case "state:changes-requested": return decideChangesRequested(input);
    default: return { sweep: false }; // not a swept state — never touch
  }
}

// in-progress: the original claim lease. Freshness is the branch's last commit
// once real work exists, else the claim event — otherwise a quiet main would
// make every fresh, still-building claim look instantly stale.
function decideInProgress({ now, staleMs, staleHours, branch, aheadBy, lastCommitAt, claimAt, updatedAt }) {
  let ref, source;
  if (aheadBy > 0) {
    ref = lastCommitAt ?? updatedAt;
    source = lastCommitAt ? "last commit" : "issue update";
  } else {
    ref = claimAt ?? updatedAt;
    source = claimAt ? "claim event" : "issue update";
  }
  if (now - ref < staleMs) return { sweep: false };
  // A pure claim (zero commits beyond main) is litter — delete the ref so the
  // issue can be cleanly re-claimed. A branch with commits is recoverable work:
  // keep it for a human to inspect.
  const deleteRef = aheadBy === 0;
  const comment = deleteRef
    ? `Stale claim swept: \`${branch}\` had no work for >${staleHours}h (measured from ${source}). Orphaned claim ref deleted; issue returned to \`state:ready\`.`
    : `Stale claim swept: no activity on \`${branch}\` for >${staleHours}h (measured from ${source}). Branch kept (has commits); issue returned to \`state:ready\`.`;
  return { sweep: true, deleteRef, comment };
}

// in-review: an issue whose PR was closed or abandoned (not merged) stays in
// review forever. The trigger is structural, not time-based — no open PR from
// the claim branch means nothing is driving it to merge, so requeue it. A
// still-open PR is live review work: never touched. The branch reached review,
// so it has commits — never delete it.
function decideInReview({ branch, hasOpenPr }) {
  if (hasOpenPr) return { sweep: false };
  return {
    sweep: true,
    deleteRef: false,
    comment: `Stale review swept: \`${branch}\` is \`state:in-review\` but has no open PR (closed or abandoned without merge). Issue returned to \`state:ready\` so it can be re-picked.`,
  };
}

// changes-requested: after a human asked for changes, a vanished agent leaves
// the issue frozen. Activity is the most recent of the issue's own update
// (comments, label and review events all bump it) and the branch's last commit
// (pushed fixes do not bump the issue). Recent activity on either front means
// the rework is live — never touched. Its branch has commits — never delete it.
function decideChangesRequested({ now, staleMs, staleHours, branch, lastCommitAt, updatedAt }) {
  const activity = Math.max(updatedAt, lastCommitAt ?? 0);
  if (now - activity < staleMs) return { sweep: false };
  return {
    sweep: true,
    deleteRef: false,
    comment: `Stale rework swept: \`${branch}\` is \`state:changes-requested\` with no activity for >${staleHours}h. Issue returned to \`state:ready\` so it can be re-picked.`,
  };
}
