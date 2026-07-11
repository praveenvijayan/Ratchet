#!/usr/bin/env node
// review-verdict-sweep.test.mjs — one test per acceptance criterion of issue
// #267 (plan 0116-review-verdict-reconciliation-sweep): a scheduled sweep
// reconciles missed Request Changes verdicts the event-driven review-verdict
// workflow never saw (conflicted PRs, Actions outages, future gaps).
//
// Follows the repo's split (see sweep-stale-claims.test.mjs): the pure decision
// core (decideReconcile, latestReviewState) is tested directly for the label
// logic; main() is driven against an in-memory API only for the orchestration
// criteria (no-issue skip, per-PR failure isolation) plus one end-to-end flip.
// Zero dependencies. Run: node scripts/review-verdict-sweep.test.mjs

import assert from "node:assert/strict";

import { decideReconcile, latestReviewState, main } from "./review-verdict-sweep.mjs";

const label = (name) => ({ name });
const review = (state, submittedAt) => ({ state, submitted_at: submittedAt });

// --- Criterion 1: an open PR whose latest review is CHANGES_REQUESTED and
// whose mapped issue still carries state:in-review gets flipped:
// state:changes-requested added, state:in-review removed. ------------------
{
  // The decision: CHANGES_REQUESTED + in-review -> flip, keeping other labels.
  const d = decideReconcile({ labels: ["state:in-review", "priority:high"], latestReviewState: "CHANGES_REQUESTED" });
  assert.equal(d.flip, true, "CHANGES_REQUESTED on an in-review issue decides a flip");
  assert.match(d.reason, /flipped/, "the decision names the flip");

  // latestReviewState picks the newest by submitted_at — so an older
  // CHANGES_REQUESTED behind a newer APPROVED is NOT the latest (no flip).
  assert.equal(
    latestReviewState([review("CHANGES_REQUESTED", "2026-07-09T00:00:00Z"), review("APPROVED", "2026-07-10T00:00:00Z")]),
    "APPROVED",
    "the latest review is the newest by submitted_at",
  );
  assert.equal(latestReviewState([]), null, "a PR with no reviews has no latest review");
}

// --- Criterion 2: an open PR whose latest review is APPROVED or COMMENTED
// causes no label change. ---------------------------------------------------
{
  for (const s of ["APPROVED", "COMMENTED", null]) {
    const d = decideReconcile({ labels: ["state:in-review"], latestReviewState: s });
    assert.equal(d.flip, false, `'${s}' latest review must not flip`);
    assert.match(d.reason, /no label change/, `'${s}' logs the no-op`);
  }
}

// --- Criterion 3: an open PR that maps to no plan issue is a logged no-op,
// not an error. (Orchestration — driven through main().) ---------------------
{
  const { result, error, logs } = await runMain(
    [openPr(8, "feature/cleanup", "Just a refactor.", [])],
    [[42, { number: 42, state: "open", labels: [label("state:in-review")] }]],
  );
  assert.equal(error, undefined, "a no-issue PR must not error the sweep");
  assert.equal(result.flipped, 0, "a no-issue PR flips nothing");
  assert.equal(api.puts.size, 0, "a no-issue PR issues no label write");
  assert.match(logs.join("\n"), /maps to no issue/, "the skip is logged");
}

// --- Criterion 4: re-running the sweep on an already-flipped issue changes
// nothing (idempotent). ------------------------------------------------------
{
  const d1 = decideReconcile({ labels: ["state:changes-requested", "priority:high"], latestReviewState: "CHANGES_REQUESTED" });
  assert.equal(d1.flip, false, "an already-changes-requested issue is not re-flipped");
  assert.match(d1.reason, /already state:changes-requested/, "the idempotent no-op is logged");

  // A CHANGES_REQUESTED latest review on an issue in any other state (e.g.
  // state:in-progress) is also left untouched — only in-review flips.
  const d2 = decideReconcile({ labels: ["state:in-progress"], latestReviewState: "CHANGES_REQUESTED" });
  assert.equal(d2.flip, false, "a non-in-review issue is not flipped");
  assert.match(d2.reason, /not state:in-review/, "the non-in-review no-op is logged");
}

// --- Criterion 5: a GitHub API failure while processing one PR is logged
// and does not abort processing of the remaining PRs. (Orchestration.) -------
{
  const { result, error, logs } = await runMain(
    [
      openPr(10, "agent/issue-42", "Closes #42", "fail"),
      openPr(11, "agent/issue-43", "Closes #43", [review("CHANGES_REQUESTED", "2026-07-10T10:00:00Z")]),
    ],
    [
      [42, { number: 42, state: "open", labels: [label("state:in-review")] }],
      [43, { number: 43, state: "open", labels: [label("state:in-review")] }],
    ],
  );
  assert.equal(error, undefined, "a per-PR API failure must not abort the sweep");
  assert.equal(result.flipped, 1, "the healthy PR after the failing one still flips");
  assert.deepEqual(api.puts.get(43), ["state:changes-requested"], "the second PR's issue is flipped");
  assert.equal(api.puts.has(42), false, "the failing PR's issue is never written");
  assert.match(logs.join("\n"), /PR #10.*could not read reviews/, "the per-PR failure is logged");
}

console.log("PASS review-verdict-sweep.test.mjs (5 criteria)");

// --- shared in-memory API + harness (used by the orchestration criteria) ---
// Defined after the tests so the decision-criteria sections read top-down with
// no harness noise. `api` and `openPr` are hoisted via function/var scoping.

function openPr(number, headRef, body, reviews) {
  return { number, state: "open", head: { ref: headRef }, body, _reviews: reviews };
}

var api;

async function runMain(prStore, issueStore) {
  api = makeApi(prStore, issueStore);
  const prev = globalThis.fetch;
  globalThis.fetch = api.fetch;
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "o/r";
  let result, error;
  try {
    result = await main();
  } catch (e) {
    error = e;
  } finally {
    console.log = realLog;
    globalThis.fetch = prev;
  }
  return { result, error, logs };
}

// In-memory GitHub API. PRs carry their reviews on `_reviews` (the string
// "fail" makes the reviews fetch throw 500 — criterion 5). Label writes land on
// `puts` for inspection.
function makeApi(prStore, issueStore = []) {
  const issues = new Map(issueStore);
  const puts = new Map();
  const prs = prStore.map((p) => ({ ...p }));
  const respond = (data, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });
  const fetch = async (url, opts = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    const page = Number(searchParams.get("page") || 1);
    const perPage = Number(searchParams.get("per_page") || 100);
    const pageSlice = (arr) => arr.slice((page - 1) * perPage, page * perPage);
    if (method === "GET" && /^\/repos\/o\/r\/pulls$/.test(pathname))
      return respond(pageSlice(prs).map(({ _reviews, ...rest }) => rest));
    const reviewsPath = pathname.match(/^\/repos\/o\/r\/pulls\/(\d+)\/reviews$/);
    if (method === "GET" && reviewsPath) {
      const found = prs.find((p) => p.number === Number(reviewsPath[1]));
      if (!found) return respond({ message: "Not Found" }, 404);
      if (found._reviews === "fail") return respond({ message: "Server Error" }, 500);
      return respond(pageSlice(found._reviews));
    }
    const single = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)$/);
    if (method === "GET" && single) {
      const issue = issues.get(Number(single[1]));
      return issue ? respond(issue) : respond({ message: "Not Found" }, 404);
    }
    const labelsPath = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/labels$/);
    if (method === "PUT" && labelsPath) {
      const n = Number(labelsPath[1]);
      puts.set(n, body.labels);
      issues.set(n, { ...issues.get(n), labels: body.labels.map(label) });
      return respond({ labels: body.labels.map(label) });
    }
    throw new Error(`unexpected request: ${method} ${pathname}`);
  };
  return { fetch, calls: [], puts };
}
