#!/usr/bin/env node
// auto-merge.test.mjs — one test per acceptance criterion of issue #480 (plan
// 0201-tiered-review-automerge): tiered review, where normal-risk PRs merge on
// green checks plus an approving recorded verdict and `risk:high` PRs wait for
// a human plus a minimum hold.
//
// Every criterion is exercised through the public interface — main() against an
// in-memory GitHub API — so the assertions are about what the sweep DOES (which
// PR got merged, what landed on it), never about the source text.
// Zero dependencies. Run: node scripts/auto-merge.test.mjs

import assert from "node:assert/strict";

import { HOLD_MINUTES, main } from "./auto-merge.mjs";

const NOW = "2026-07-25T12:00:00Z";
const minutesBefore = (n) => new Date(new Date(NOW) - n * 60000).toISOString();

const greenChecks = (at = minutesBefore(60)) => [{ status: "completed", conclusion: "success", completed_at: at }];
const botReview = (state, at = minutesBefore(50)) => ({ state, submitted_at: at, user: { login: "github-actions[bot]", type: "Bot" } });
const humanReview = (state, at = minutesBefore(40)) => ({ state, submitted_at: at, user: { login: "praveenvijayan", type: "User" } });

// --- Criterion 1: a PR without the risk:high label, with all required checks
// green and an approving recorded review verdict, is merged automatically with
// no human action (no human review exists on this PR at all). ----------------
{
  const { result, api, error } = await run([
    pr(101, { labels: ["state:in-review"], checks: greenChecks(), reviews: [botReview("APPROVED")] }),
  ]);
  assert.equal(error, undefined, "the sweep must not error");
  assert.equal(result.merged, 1, "the green, approved, normal-risk PR is merged");
  assert.deepEqual(api.merges.get(101), "sha-101", "the merge is pinned to the head SHA we judged");
}

// --- Criterion 2: a normal-risk PR with green checks but a changes-requested
// verdict is not auto-merged — it follows the existing rework path. ----------
{
  const reviews = [botReview("APPROVED", minutesBefore(55)), botReview("CHANGES_REQUESTED", minutesBefore(50))];
  const { result, api, logs } = await run([pr(102, { labels: ["state:in-review"], checks: greenChecks(), reviews })]);
  assert.equal(result.merged, 0, "a changes-requested verdict must not merge");
  assert.equal(api.merges.size, 0, "no merge call is issued");
  assert.equal(api.comments.get(102), undefined, "the rework path owns the PR — the sweep adds no comment");
  assert.match(logs.join("\n"), /rework path/, "the skip names the rework path");
}

// --- Criterion 3: a PR carrying risk:high is never auto-merged on the verdict
// alone: it requires a human approval, and at least HOLD_MINUTES must elapse
// between the PR becoming mergeable and the merge. ---------------------------
{
  // (a) bot-approved only, well past the hold — no human approval, no merge.
  const botOnly = await run([pr(103, { labels: ["risk:high"], checks: greenChecks(minutesBefore(60)), reviews: [botReview("APPROVED")] })]);
  assert.equal(botOnly.result.merged, 0, "risk:high does not merge without a human approval");
  assert.match(botOnly.logs.join("\n"), /needs a human approval/, "the skip names the missing human approval");

  // (b) human-approved but only 5 minutes since mergeable — the hold blocks it.
  const soonReviews = [botReview("APPROVED", minutesBefore(6)), humanReview("APPROVED", minutesBefore(4))];
  const tooSoon = await run([pr(104, { labels: ["risk:high"], checks: greenChecks(minutesBefore(5)), reviews: soonReviews })]);
  assert.equal(tooSoon.result.merged, 0, "risk:high does not merge inside the hold window");
  assert.equal(tooSoon.api.merges.size, 0, "no merge call is issued inside the hold");
  assert.match(tooSoon.logs.join("\n"), new RegExp(`5 of ${HOLD_MINUTES} min`), "the skip reports the elapsed hold");

  // (c) human-approved and past the hold — now it merges.
  const readyReviews = [botReview("APPROVED", minutesBefore(25)), humanReview("APPROVED", minutesBefore(18))];
  const ready = await run([pr(105, { labels: ["risk:high"], checks: greenChecks(minutesBefore(20)), reviews: readyReviews })]);
  assert.equal(ready.result.merged, 1, "risk:high merges once a human approved and the hold elapsed");
  assert.equal(ready.api.merges.get(105), "sha-105", "the risk:high merge is pinned to its head SHA");
}

// --- Criterion 4: every auto-merge records what it acted on — the verdict, the
// check state, and the risk tier are visible on the PR after the fact. -------
{
  const normal = await run([pr(106, { labels: ["state:in-review"], checks: greenChecks(), reviews: [botReview("APPROVED")] })]);
  const body = (normal.api.comments.get(106) || []).join("\n");
  assert.match(body, /risk tier: `normal`/, "the record names the risk tier it acted on");
  assert.match(body, /check state: `success`/, "the record names the check state it acted on");
  assert.match(body, /recorded review verdict: `APPROVED`/, "the record names the verdict it acted on");

  const highReviews = [botReview("APPROVED", minutesBefore(35)), humanReview("APPROVED", minutesBefore(28))];
  const high = await run([pr(107, { labels: ["risk:high"], checks: greenChecks(minutesBefore(30)), reviews: highReviews })]);
  const highBody = (high.api.comments.get(107) || []).join("\n");
  assert.match(highBody, /risk tier: `risk:high`/, "the risk:high record names its tier");
  assert.match(highBody, /human review verdict: `APPROVED`/, "the risk:high record names the human approval");
  assert.match(highBody, new RegExp(`held \`30\` min since mergeable \\(minimum \`${HOLD_MINUTES}\`\\)`), "the risk:high record names the hold it observed");
}

// --- Criterion 5: when auto-merge fails (race with a new push, API error), the
// PR is left un-merged with a comment stating why — never a silent retry loop.
{
  const mergeable = () => pr(108, { checks: greenChecks(), reviews: [botReview("APPROVED")], mergeFails: 409 });

  const first = await run([mergeable()]);
  assert.equal(first.error, undefined, "a merge failure must not abort the sweep");
  assert.equal(first.result.merged, 0, "the PR is left un-merged");
  const why = (first.api.comments.get(108) || []).join("\n");
  assert.match(why, /Auto-merge failed/, "the failure is stated on the PR");
  assert.match(why, /409/, "the comment states why it failed");

  // Re-running with that comment already present: no second merge attempt, no
  // duplicate comment — the failure is recorded once per head SHA, not retried.
  const again = await run([mergeable()], first.api.comments.get(108));
  assert.equal(again.result.merged, 0, "the second pass still merges nothing");
  assert.equal(again.api.merges.size, 0, "the second pass issues no merge call — no retry loop");
  assert.equal(again.api.comments.get(108), undefined, "the second pass adds no duplicate comment");
  assert.match(again.logs.join("\n"), /not retrying/, "the skipped retry is logged");
}

console.log("PASS auto-merge.test.mjs (5 criteria)");

// --- in-memory GitHub API + harness ----------------------------------------
// Defined after the tests so the criteria read top-down with no harness noise.

function pr(number, { labels = [], checks = [], reviews = [], draft = false, mergeFails = null }) {
  return {
    number, state: "open", draft, body: `Closes #${number}`,
    head: { ref: `agent/issue-${number}`, sha: `sha-${number}` },
    labels: labels.map((name) => ({ name })),
    _checks: checks, _reviews: reviews, _mergeFails: mergeFails,
  };
}

async function run(prStore, existingComments = []) {
  const api = makeApi(prStore, existingComments);
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  const auth = () => ({ token: "test-token", repo: "o/r" });
  let result, error;
  try {
    result = await main({ auth, fetchImpl: api.fetch, now: () => NOW });
  } catch (e) {
    error = e;
  } finally {
    console.log = realLog;
  }
  return { result, error, logs, api };
}

function makeApi(prStore, existingComments) {
  const prs = prStore.map((p) => ({ ...p }));
  const merges = new Map();
  const comments = new Map();
  const respond = (data, status = 200) => ({
    ok: status < 400, status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });
  const fetch = async (url, opts = {}) => {
    const { pathname } = new URL(url);
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (method === "GET" && pathname === "/repos/o/r/pulls") return respond(prs);
    let m;
    if ((m = pathname.match(/^\/repos\/o\/r\/commits\/(.+)\/check-runs$/))) {
      const target = prs.find((p) => p.head.sha === m[1]);
      return respond({ check_runs: target?._checks ?? [] });
    }
    if ((m = pathname.match(/^\/repos\/o\/r\/pulls\/(\d+)\/reviews$/))) {
      return respond(prs.find((p) => p.number === Number(m[1]))?._reviews ?? []);
    }
    if ((m = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments$/))) {
      const n = Number(m[1]);
      if (method === "POST") {
        comments.set(n, [...(comments.get(n) || []), body.body]);
        return respond({ id: 1 }, 201);
      }
      // Only the seeded prior-run comments are visible to a GET; comments this
      // run posts land in `comments` for inspection.
      return respond((existingComments || []).map((b) => ({ body: b })));
    }
    if (method === "PUT" && (m = pathname.match(/^\/repos\/o\/r\/pulls\/(\d+)\/merge$/))) {
      const target = prs.find((p) => p.number === Number(m[1]));
      if (target?._mergeFails) return respond({ message: "Head branch was modified" }, target._mergeFails);
      merges.set(target.number, body.sha);
      return respond({ merged: true, sha: body.sha });
    }
    throw new Error(`unexpected ${method} ${pathname}`);
  };
  return { fetch, merges, comments };
}
