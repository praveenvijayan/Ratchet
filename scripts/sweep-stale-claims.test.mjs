#!/usr/bin/env node
// sweep-stale-claims.test.mjs — the sweep decision, one case per acceptance
// criterion of "extend the stale sweep to in-review and changes-requested".
// Zero dependencies. Run:  node scripts/sweep-stale-claims.test.mjs
//
// decideSweep is a pure function of already-fetched signals, so the whole
// decision is exercised through its public interface with no network or mocks.

import assert from "node:assert/strict";
import { decideSweep } from "./sweep-stale-claims.mjs";

const HOUR = 3600 * 1000;
const now = 1_700_000_000_000; // fixed clock (no Date.now dependence)
const staleHours = "2";
const staleMs = Number(staleHours) * HOUR;
const base = { now, staleMs, staleHours, branch: "agent/issue-12" };
const stale = now - staleMs - HOUR; // comfortably outside the window
const recent = now - HOUR;          // comfortably inside the window

// AC1: a state:in-review issue with no open PR from its agent/issue-<N> branch
// returns to state:ready with a comment explaining why.
{
  const r = decideSweep({ ...base, state: "state:in-review", hasOpenPr: false });
  assert.equal(r.sweep, true, "in-review with no open PR must be swept");
  assert.equal(r.deleteRef, false, "a reviewed branch has commits — never deleted");
  assert.match(r.comment, /in-review/, "comment must name the state");
  assert.match(r.comment, /no open PR/, "comment must explain the reason");
  assert.match(r.comment, /state:ready/, "comment must state the outcome");
}

// AC2: a state:changes-requested issue with no activity beyond the configurable
// window returns to state:ready with a comment.
{
  const r = decideSweep({ ...base, state: "state:changes-requested", updatedAt: stale, lastCommitAt: stale });
  assert.equal(r.sweep, true, "changes-requested with no activity past the window must be swept");
  assert.equal(r.deleteRef, false, "a changes-requested branch has commits — never deleted");
  assert.match(r.comment, /changes-requested/, "comment must name the state");
  assert.match(r.comment, /state:ready/, "comment must state the outcome");
}

// AC3: an in-review issue with an open PR, and a changes-requested issue with
// recent activity, are never touched by the sweep.
{
  const openPr = decideSweep({ ...base, state: "state:in-review", hasOpenPr: true });
  assert.equal(openPr.sweep, false, "in-review with an open PR must never be swept");

  // Activity is the most recent of issue update and last commit: a fresh pushed
  // fix keeps the rework alive even when issue.updated_at is stale.
  const active = decideSweep({ ...base, state: "state:changes-requested", updatedAt: stale, lastCommitAt: recent });
  assert.equal(active.sweep, false, "recent activity (a pushed commit) must protect changes-requested");
}

// Regression: the extracted in-progress logic is unchanged. A zero-commit claim
// stale by its claim event is swept and its orphan ref deleted; a branch with a
// recent commit is not swept even when issue.updated_at is old (it times from
// the commit, not the issue).
{
  const orphan = decideSweep({ ...base, state: "state:in-progress", aheadBy: 0, lastCommitAt: null, claimAt: stale, updatedAt: now });
  assert.equal(orphan.sweep, true, "stale zero-commit claim must be swept");
  assert.equal(orphan.deleteRef, true, "orphan claim ref must be deleted");

  const working = decideSweep({ ...base, state: "state:in-progress", aheadBy: 3, lastCommitAt: recent, claimAt: null, updatedAt: stale });
  assert.equal(working.sweep, false, "a branch with a recent commit must not be swept");
}

// A state the sweep does not patrol is never touched.
assert.equal(decideSweep({ ...base, state: "state:blocked" }).sweep, false, "non-swept states are left alone");

console.log("PASS sweep-stale-claims.test.mjs (13 assertions)");
