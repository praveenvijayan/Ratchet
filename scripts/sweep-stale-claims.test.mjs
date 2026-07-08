#!/usr/bin/env node
// sweep-stale-claims.test.mjs — the sweep decision, one case per acceptance
// criterion of "extend the stale sweep to in-review and changes-requested".
// Zero dependencies. Run:  node scripts/sweep-stale-claims.test.mjs
//
// decideSweep is a pure function of already-fetched signals, so the whole
// decision is exercised through its public interface with no network or mocks.

import assert from "node:assert/strict";
import { decideSweep, main } from "./sweep-stale-claims.mjs";

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

// Renewable-lease heartbeat (from the merged sweep-lease rule): a recent
// heartbeat comment renews the lease without a push, in both time-based states,
// even when every other signal is stale.
{
  const beat = decideSweep({ ...base, state: "state:in-progress", aheadBy: 0, lastCommitAt: null, claimAt: stale, heartbeatAt: recent, updatedAt: stale });
  assert.equal(beat.sweep, false, "a recent heartbeat must protect a zero-commit in-progress claim");

  const rework = decideSweep({ ...base, state: "state:changes-requested", updatedAt: stale, lastCommitAt: stale, heartbeatAt: recent });
  assert.equal(rework.sweep, false, "a recent heartbeat must protect changes-requested rework");
}

// A state the sweep does not patrol is never touched.
assert.equal(decideSweep({ ...base, state: "state:blocked" }).sweep, false, "non-swept states are left alone");

// --- orchestration (main): the extracted driver applies the decision ---------
// Drives main() against an in-memory GitHub API. Behaviour must match what the
// workflow YAML did: sweep an in-review claim with no PR, delete a stale zero-
// commit claim's ref, and leave a freshly-committed claim alone.
{
  const staleIso = new Date(now - 3 * HOUR).toISOString();  // outside the 2h window
  const recentIso = new Date(now - 0.5 * HOUR).toISOString(); // inside it
  const label = (name) => ({ name });
  const openIssues = [
    { number: 100, pull_request: undefined, updated_at: recentIso, assignees: [{ login: "alice" }], labels: [label("state:in-review"), label("priority:low")] },
    { number: 200, pull_request: undefined, updated_at: staleIso, assignees: [], labels: [label("state:in-progress")] },
    { number: 300, pull_request: undefined, updated_at: staleIso, assignees: [], labels: [label("state:in-progress")] },
  ];
  const calls = [];
  const respond = (data, status = 200) => ({ ok: true, status, json: async () => data, text: async () => JSON.stringify(data) });
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, pathname, body });
    if (method === "GET" && pathname === "/repos/o/r/issues") {
      return respond(Number(searchParams.get("page")) === 1 ? openIssues : []);
    }
    if (method === "GET" && pathname === "/repos/o/r/pulls") return respond([]); // no open PR for #100
    if (method === "GET" && pathname === "/repos/o/r/compare/main...agent/issue-200") return respond({ ahead_by: 0 });
    if (method === "GET" && pathname === "/repos/o/r/compare/main...agent/issue-300") return respond({ ahead_by: 3 });
    if (method === "GET" && pathname === "/repos/o/r/commits") return respond([{ commit: { committer: { date: recentIso } } }]);
    if (method === "GET" && /\/issues\/\d+\/comments$/.test(pathname)) return respond([]);
    if (method === "GET" && /\/issues\/\d+\/events$/.test(pathname)) {
      return respond([{ event: "labeled", label: { name: "state:in-progress" }, created_at: staleIso }]);
    }
    if (method !== "GET") return respond({}, 200); // PUT labels / DELETE assignees / DELETE ref / POST comment
    throw new Error(`unexpected request: ${method} ${pathname}`);
  };

  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "o/r";
  process.env.STALE_HOURS = "2";
  process.env.SWEEP_NOW = String(now);
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let result;
  try {
    result = await main();
  } finally {
    console.log = realLog;
  }

  const put = (n) => calls.find((c) => c.method === "PUT" && c.pathname === `/repos/o/r/issues/${n}/labels`);
  // #100 in-review, no PR: requeued to ready, its state label dropped, others kept.
  assert.ok(put(100), "in-review claim with no PR must be relabelled");
  assert.ok(put(100).body.labels.includes("state:ready"), "#100 must become state:ready");
  assert.ok(!put(100).body.labels.includes("state:in-review"), "#100 must lose its old state label");
  assert.ok(put(100).body.labels.includes("priority:low"), "#100 must keep its non-state labels");
  assert.ok(calls.some((c) => c.method === "DELETE" && c.pathname === "/repos/o/r/issues/100/assignees"), "#100 assignees must be cleared");
  assert.ok(calls.some((c) => c.method === "POST" && c.pathname === "/repos/o/r/issues/100/comments" && /in-review/.test(c.body.body)), "#100 must get an explanatory comment");
  assert.ok(!calls.some((c) => c.method === "DELETE" && c.pathname === "/repos/o/r/git/refs/heads/agent/issue-100"), "a reviewed branch must never be deleted");
  // #200 stale zero-commit claim: requeued AND its orphan ref deleted.
  assert.ok(put(200)?.body.labels.includes("state:ready"), "#200 stale zero-commit claim must be swept to ready");
  assert.ok(calls.some((c) => c.method === "DELETE" && c.pathname === "/repos/o/r/git/refs/heads/agent/issue-200"), "#200 orphan claim ref must be deleted");
  // #300 freshly-committed claim: untouched.
  assert.ok(!put(300), "a claim with a recent commit must not be swept");
  assert.equal(result.swept, 2, "exactly two issues were swept");
}

console.log("PASS sweep-stale-claims.test.mjs (25 assertions)");
