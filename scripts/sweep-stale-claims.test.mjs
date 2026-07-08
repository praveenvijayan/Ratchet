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
const reworkGraceHours = "2";
const reworkGraceMs = Number(reworkGraceHours) * HOUR;
const base = { now, staleMs, staleHours, reworkGraceMs, reworkGraceHours, branch: "agent/issue-12" };
const stale = now - staleMs - HOUR; // comfortably outside the window
const recent = now - HOUR;          // comfortably inside the window

// AC1: a state:in-review issue with no open PR from its agent/issue-<N> branch
// returns to state:ready with a comment explaining why.
{
  const r = decideSweep({ ...base, state: "state:in-review", prState: "closed" });
  assert.equal(r.sweep, true, "in-review with no open PR must be swept");
  assert.equal(r.deleteRef, false, "a reviewed branch has commits — never deleted");
  assert.match(r.comment, /in-review/, "comment must name the state");
  assert.match(r.comment, /no open PR/, "comment must explain the reason");
  assert.match(r.comment, /state:ready/, "comment must state the outcome");
}

// #53 AC1: an in-review issue whose agent PR was merged must not be returned to
// the ready queue with the old "abandoned without merge" story; the comment
// states that the PR merged while the issue stayed open.
{
  const r = decideSweep({ ...base, state: "state:in-review", prState: "merged", prNumber: 44 });
  assert.equal(r.sweep, true, "merged review work must be handled");
  assert.equal(r.targetState, "state:blocked", "merged work must not be requeued for another agent");
  assert.doesNotMatch(r.comment, /abandoned without merge/, "merged PRs must not get the abandoned wording");
  assert.match(r.comment, /PR #44 was merged/, "comment must state what actually happened");
  assert.match(r.comment, /state:blocked/, "comment must state the non-ready outcome");
}

// #53 AC2: a closed PR that carries review feedback gets a configurable grace
// window before the sweep may requeue it, so the original agent can rework the
// same branch/PR path described in AGENTS.md step 6.
{
  const freshClose = decideSweep({
    ...base,
    state: "state:in-review",
    prState: "closed-with-feedback",
    prNumber: 45,
    prClosedAt: recent,
  });
  assert.equal(freshClose.sweep, false, "closed review feedback inside the grace window must not be swept");

  const staleClose = decideSweep({
    ...base,
    state: "state:in-review",
    prState: "closed-with-feedback",
    prNumber: 45,
    prClosedAt: stale,
  });
  assert.equal(staleClose.sweep, true, "closed review feedback past the grace window can be requeued");
  assert.equal(staleClose.targetState, "state:ready", "expired rework grace returns the issue to ready");
  assert.match(staleClose.comment, /closed with review feedback/, "comment must explain the rework-specific reason");
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
  const openPr = decideSweep({ ...base, state: "state:in-review", prState: "open" });
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

// #53 AC3: a stale issue whose branch has vanished gets an accurate comment; it
// must not claim the branch was kept because it had commits.
{
  const vanished = decideSweep({ ...base, state: "state:in-progress", branchExists: false, aheadBy: null, lastCommitAt: null, claimAt: stale, updatedAt: stale });
  assert.equal(vanished.sweep, true, "a stale claim with a vanished branch must be swept");
  assert.equal(vanished.deleteRef, false, "there is no vanished ref to delete");
  assert.match(vanished.comment, /branch no longer exists/, "comment must say the branch vanished");
  assert.doesNotMatch(vanished.comment, /Branch kept \(has commits\)/, "vanished branch comment must not claim the branch was kept");
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
    { number: 150, pull_request: undefined, updated_at: recentIso, assignees: [{ login: "alice" }], labels: [label("state:in-review"), label("priority:medium")] },
    { number: 200, pull_request: undefined, updated_at: staleIso, assignees: [], labels: [label("state:in-progress")] },
    { number: 300, pull_request: undefined, updated_at: staleIso, assignees: [], labels: [label("state:in-progress")] },
  ];
  // Every requeued issue is re-read at write time; give the ready-bound ones a
  // body that still carries acceptance criteria so they are not held at draft.
  const withCriteria = "Body.\n\n## Acceptance criteria\n- [ ] does the observable thing\n";
  const freshBodies = { 100: withCriteria, 150: withCriteria, 200: withCriteria };
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
    if (method === "GET" && /^\/repos\/o\/r\/issues\/\d+$/.test(pathname)) {
      const n = Number(pathname.split("/").pop());
      const src = openIssues.find((i) => i.number === n);
      return respond({ ...src, body: freshBodies[n] ?? "" });
    }
    if (method === "GET" && pathname === "/repos/o/r/pulls") {
      if (searchParams.get("head") === "o:agent/issue-150") return respond([{ number: 15, state: "closed", merged_at: "2026-01-01T00:00:00Z", closed_at: staleIso }]);
      return respond([]); // no PR for #100, no PR signals for in-progress issues
    }
    if (method === "GET" && pathname === "/repos/o/r/pulls/15") return respond({ number: 15, state: "closed", merged_at: "2026-01-01T00:00:00Z", closed_at: staleIso, comments: 0, review_comments: 0 });
    if (method === "GET" && pathname === "/repos/o/r/pulls/15/reviews") return respond([]);
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
  // #150 merged PR, issue still open: moved out of the pick queue, not requeued.
  assert.ok(put(150)?.body.labels.includes("state:blocked"), "#150 merged work must become blocked, not ready");
  assert.ok(!put(150).body.labels.includes("state:ready"), "#150 merged work must not be requeued");
  assert.ok(calls.some((c) => c.method === "POST" && c.pathname === "/repos/o/r/issues/150/comments" && /PR #15 was merged/.test(c.body.body)), "#150 must get an accurate merged-PR comment");
  // #200 stale zero-commit claim: requeued AND its orphan ref deleted.
  assert.ok(put(200)?.body.labels.includes("state:ready"), "#200 stale zero-commit claim must be swept to ready");
  assert.ok(calls.some((c) => c.method === "DELETE" && c.pathname === "/repos/o/r/git/refs/heads/agent/issue-200"), "#200 orphan claim ref must be deleted");
  // #300 freshly-committed claim: untouched.
  assert.ok(!put(300), "a claim with a recent commit must not be swept");
  assert.equal(result.swept, 3, "exactly three issues were swept");
}

// --- #54 orchestration: criteria gate + write-time re-read -------------------
// AC1: a swept issue whose live body lost its acceptance criteria is held at
// state:draft, never re-exposed as state:ready. AC2: labels are computed from a
// re-read at write time — a state change made after the initial listing is not
// overwritten, and the written label set reflects the fresh snapshot.
{
  const staleIso = new Date(now - 3 * HOUR).toISOString();
  const label = (name) => ({ name });
  const withCriteria = "Body.\n\n## Acceptance criteria\n- [ ] does the thing\n\n<!-- plan-id: 0029-sweep-requeue-safety -->";
  const noCriteria = "Body with no criteria at all.\n\n<!-- plan-id: 0029-sweep-requeue-safety -->";
  // All three are stale zero-commit in-progress claims, so decideSweep decides
  // to sweep each; the write-time re-read is what differentiates them.
  const openIssues = [
    { number: 500, pull_request: undefined, updated_at: staleIso, assignees: [], labels: [label("state:in-progress"), label("priority:medium")] },
    { number: 600, pull_request: undefined, updated_at: staleIso, assignees: [], labels: [label("state:in-progress")] },
    { number: 700, pull_request: undefined, updated_at: staleIso, assignees: [{ login: "bob" }], labels: [label("state:in-progress"), label("priority:low")] },
  ];
  // Re-reads at write time: #500 lost its criteria; #600 was moved to in-review
  // by an agent after the listing; #700 gained a non-state label, kept criteria.
  const fresh = {
    500: { number: 500, assignees: [], labels: [label("state:in-progress"), label("priority:medium")], body: noCriteria },
    600: { number: 600, assignees: [], labels: [label("state:in-review")], body: withCriteria },
    700: { number: 700, assignees: [{ login: "bob" }], labels: [label("state:in-progress"), label("priority:low"), label("needs-design")], body: withCriteria },
  };
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
    if (method === "GET" && /^\/repos\/o\/r\/issues\/\d+$/.test(pathname)) {
      return respond(fresh[Number(pathname.split("/").pop())]);
    }
    if (method === "GET" && /^\/repos\/o\/r\/compare\/main\.\.\.agent\/issue-\d+$/.test(pathname)) return respond({ ahead_by: 0 });
    if (method === "GET" && /\/issues\/\d+\/comments$/.test(pathname)) return respond([]);
    if (method === "GET" && /\/issues\/\d+\/events$/.test(pathname)) {
      return respond([{ event: "labeled", label: { name: "state:in-progress" }, created_at: staleIso }]);
    }
    if (method !== "GET") return respond({}, 200);
    throw new Error(`unexpected request: ${method} ${pathname}`);
  };

  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "o/r";
  process.env.STALE_HOURS = "2";
  process.env.SWEEP_NOW = String(now);
  const realLog = console.log;
  console.log = () => {};
  let result;
  try {
    result = await main();
  } finally {
    console.log = realLog;
  }

  const put = (n) => calls.find((c) => c.method === "PUT" && c.pathname === `/repos/o/r/issues/${n}/labels`);
  const comment = (n) => calls.find((c) => c.method === "POST" && c.pathname === `/repos/o/r/issues/${n}/comments`);

  // #54 AC1: #500 lost its criteria -> held at state:draft, never state:ready,
  // with an explanatory comment; the orphan claim ref is still deleted.
  assert.ok(put(500), "#500 must be relabelled");
  assert.ok(put(500).body.labels.includes("state:draft"), "#500 with no criteria must become state:draft");
  assert.ok(!put(500).body.labels.includes("state:ready"), "#500 must never be requeued as ready");
  assert.match(comment(500).body.body, /state:draft/, "#500 comment must explain the draft hold");
  assert.match(comment(500).body.body, /acceptance criteria/i, "#500 comment must name the missing criteria");
  assert.ok(calls.some((c) => c.method === "DELETE" && c.pathname === "/repos/o/r/git/refs/heads/agent/issue-500"), "#500 orphan claim ref must still be deleted");

  // #54 AC2: #600 was moved to state:in-review after listing -> the sweep must
  // not overwrite that newer state; no label write, no comment.
  assert.ok(!put(600), "#600 must not be relabelled after its state changed since listing");
  assert.ok(!comment(600), "#600 must not be commented after its state changed since listing");

  // #54 AC2: #700's written labels come from the write-time re-read — the
  // non-state label added in the window is preserved; criteria keep it ready.
  assert.ok(put(700), "#700 must be relabelled");
  assert.ok(put(700).body.labels.includes("state:ready"), "#700 with criteria must return to ready");
  assert.ok(put(700).body.labels.includes("needs-design"), "#700 must keep the label added after listing (labels re-read at write time)");
  assert.ok(put(700).body.labels.includes("priority:low"), "#700 must keep its existing non-state labels");

  assert.equal(result.swept, 2, "#500 and #700 swept; #600 skipped on the state-change guard");
}

// --- #87 orchestration: PR disposition robustness + config validation --------
// AC1: a closed PR whose only feedback is a Request Changes review body gets
// the rework grace window. AC2: multiple PRs on one branch are judged by the
// newest PR, and the sweep comment names that PR. AC3: PR lookup paginates, so
// an open PR is found even after many old branch PRs. AC4: invalid hour config
// fails loudly before the sweep can silently disable itself.
{
  const staleIso = new Date(now - 5 * HOUR).toISOString();
  const recentIso = new Date(now - 0.5 * HOUR).toISOString();
  const label = (name) => ({ name });
  const withCriteria = "Body.\n\n## Acceptance criteria\n- [ ] does the thing\n";
  const openIssues = [
    { number: 810, pull_request: undefined, updated_at: staleIso, assignees: [], labels: [label("state:in-review"), label("priority:medium")] },
    { number: 820, pull_request: undefined, updated_at: staleIso, assignees: [], labels: [label("state:in-review"), label("priority:medium")] },
    { number: 830, pull_request: undefined, updated_at: staleIso, assignees: [], labels: [label("state:in-review"), label("priority:medium")] },
  ];
  const oldClosed = Array.from({ length: 100 }, (_, i) => ({
    number: 900 + i,
    state: "closed",
    merged_at: null,
    closed_at: staleIso,
    updated_at: staleIso,
    created_at: staleIso,
  }));
  const calls = [];
  const respond = (data, status = 200) => ({ ok: true, status, json: async () => data, text: async () => JSON.stringify(data) });
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, pathname, body, search: Object.fromEntries(searchParams.entries()) });
    if (method === "GET" && pathname === "/repos/o/r/issues") {
      return respond(Number(searchParams.get("page")) === 1 ? openIssues : []);
    }
    if (method === "GET" && /^\/repos\/o\/r\/issues\/\d+$/.test(pathname)) {
      const n = Number(pathname.split("/").pop());
      const src = openIssues.find((i) => i.number === n);
      return respond({ ...src, body: withCriteria });
    }
    if (method === "GET" && pathname === "/repos/o/r/pulls") {
      const head = searchParams.get("head");
      const page = Number(searchParams.get("page"));
      if (head === "o:agent/issue-810") {
        return respond(page === 1 ? [{ number: 810, state: "closed", merged_at: null, closed_at: recentIso, updated_at: recentIso, created_at: staleIso }] : []);
      }
      if (head === "o:agent/issue-820") {
        return respond(page === 1 ? [
          { number: 81, state: "closed", merged_at: "2026-01-01T00:00:00Z", closed_at: staleIso, updated_at: staleIso, created_at: staleIso },
          { number: 82, state: "closed", merged_at: null, closed_at: recentIso, updated_at: recentIso, created_at: staleIso },
        ] : []);
      }
      if (head === "o:agent/issue-830") {
        return respond(page === 1 ? oldClosed : [{ number: 830, state: "open", merged_at: null, closed_at: null, updated_at: recentIso, created_at: recentIso }]);
      }
      return respond([]);
    }
    if (method === "GET" && pathname === "/repos/o/r/pulls/810") return respond({ number: 810, state: "closed", comments: 0, review_comments: 0 });
    if (method === "GET" && pathname === "/repos/o/r/pulls/810/reviews") return respond([{ state: "CHANGES_REQUESTED", body: "Please tighten the edge case." }]);
    if (method === "GET" && pathname === "/repos/o/r/pulls/82") return respond({ number: 82, state: "closed", comments: 0, review_comments: 0 });
    if (method === "GET" && pathname === "/repos/o/r/pulls/82/reviews") return respond([]);
    if (method !== "GET") return respond({}, 200);
    throw new Error(`unexpected request: ${method} ${pathname}`);
  };

  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "o/r";
  process.env.STALE_HOURS = "2";
  process.env.REWORK_GRACE_HOURS = "2";
  process.env.SWEEP_NOW = String(now);
  const realLog = console.log;
  console.log = () => {};
  let result;
  try {
    result = await main();
  } finally {
    console.log = realLog;
  }

  const put = (n) => calls.find((c) => c.method === "PUT" && c.pathname === `/repos/o/r/issues/${n}/labels`);
  const comment = (n) => calls.find((c) => c.method === "POST" && c.pathname === `/repos/o/r/issues/${n}/comments`);

  assert.ok(!put(810), "a PR closed recently with only review-body feedback must stay in grace");
  assert.ok(put(820)?.body.labels.includes("state:ready"), "the newest closed PR with no feedback must be requeued");
  assert.match(comment(820).body.body, /PR #82/, "the sweep comment must name the newest PR it acted on");
  assert.doesNotMatch(comment(820).body.body, /PR #81/, "the sweep must not act on an older merged PR");
  assert.ok(!put(830), "an open PR found on a later page must protect in-review work");
  assert.ok(calls.some((c) => c.method === "GET" && c.pathname === "/repos/o/r/pulls" && c.search.head === "o:agent/issue-830" && c.search.page === "2"), "PR lookup must paginate past the first page");
  assert.equal(result.swept, 1, "only #820 should be swept in the PR-disposition regression set");
}

{
  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "o/r";
  process.env.SWEEP_NOW = String(now);
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("fetch should not run with invalid sweep configuration");
  };

  process.env.STALE_HOURS = "not-a-number";
  process.env.REWORK_GRACE_HOURS = "2";
  await assert.rejects(() => main(), /STALE_HOURS.*not-a-number/, "invalid STALE_HOURS must fail loudly");
  assert.equal(called, false, "invalid STALE_HOURS must fail before any API call");

  process.env.STALE_HOURS = "2";
  process.env.REWORK_GRACE_HOURS = "later";
  await assert.rejects(() => main(), /REWORK_GRACE_HOURS.*later/, "invalid REWORK_GRACE_HOURS must fail loudly");
  assert.equal(called, false, "invalid REWORK_GRACE_HOURS must fail before any API call");
}

console.log("PASS sweep-stale-claims.test.mjs (issue #87 robustness covered)");
