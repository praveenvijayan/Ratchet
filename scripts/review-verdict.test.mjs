#!/usr/bin/env node
// review-verdict.test.mjs — one test per acceptance criterion of issue #197
// (plan 0098-review-verdict-label-workflow): a pull_request_review workflow
// flips the mapped issue to state:changes-requested on a Request Changes
// verdict. Drives main() against an in-memory GitHub API. Criterion 6 closes
// the loop by counting its own sibling tests against the plan's criteria.
// Zero dependencies. Run: node scripts/review-verdict.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { mapIssueNumber, main } from "./review-verdict.mjs";

const label = (name) => ({ name });

// In-memory issue store, keyed by number. Each test seeds the issue the PR
// maps to; main() reads it via GET /repos/o/r/issues/<N>.
const reviewState = (state) => ({ state });

// Build a pull_request_review payload. `headRef` is the PR head branch; `body`
// the PR body; `prNumber` the PR number. The review state comes from `state`.
const event = (state, { headRef = "agent/issue-42", body = "Closes #42", prNumber = 7 } = {}) => ({
  action: "submitted",
  review: reviewState(state),
  pull_request: { number: prNumber, head: { ref: headRef }, body },
});

// Minimal in-memory GitHub API. Issues live in the `issues` Map; label writes
// land on `puts` for inspection. fetch is reset per test.
function makeApi(issueStore) {
  const calls = [];
  const issues = new Map(issueStore);
  const puts = new Map();
  const respond = (data, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });
  const fetch = async (url, opts = {}) => {
    const { pathname } = new URL(url);
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, pathname, body });
    const single = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)$/);
    const labelsPath = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/labels$/);
    if (method === "GET" && single) {
      const issue = issues.get(Number(single[1]));
      return issue ? respond(issue) : respond({ message: "Not Found" }, 404);
    }
    if (method === "PUT" && labelsPath) {
      const n = Number(labelsPath[1]);
      if (body?._fail) return respond({ message: "Forbidden" }, 403);
      puts.set(n, body.labels);
      issues.set(n, { ...issues.get(n), labels: body.labels.map(label) });
      return respond({ labels: body.labels.map(label) });
    }
    throw new Error(`unexpected request: ${method} ${pathname}`);
  };
  return { fetch, calls, puts };
}

const baseEnv = () => {
  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "o/r";
};

const capture = async (fetch, event) => {
  const prev = globalThis.fetch;
  globalThis.fetch = fetch;
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  process.env.REVIEW_EVENT = JSON.stringify(event);
  let result, error;
  try {
    result = await main();
  } catch (e) {
    error = e;
  } finally {
    console.log = realLog;
    globalThis.fetch = prev;
    delete process.env.REVIEW_EVENT;
  }
  return { result, error, logs };
};

// --- Criterion 1: a CHANGES_REQUESTED review submitted on an open PR whose
// branch is agent/issue-<N> (or whose body says Closes #<N>) moves issue N
// from state:in-review to state:changes-requested. ---------------------------
{
  baseEnv();

  // Via the agent/issue-<N> head branch.
  const api1 = makeApi([[42, { number: 42, state: "open", labels: [label("state:in-review"), label("priority:high")] }]]);
  const r1 = await capture(api1.fetch, event("changes_requested", { headRef: "agent/issue-42", body: "Fix it." }));
  assert.equal(r1.error, undefined, `branch mapping must not error: ${r1.error?.message ?? ""}`);
  assert.ok(r1.result.flipped, "branch-mapped CHANGES_REQUESTED must flip the issue");
  assert.deepEqual(api1.puts.get(42), ["priority:high", "state:changes-requested"],
    "the flip swaps state:in-review for state:changes-requested, keeping other labels");

  // Via a `Closes #<N>` body marker when the branch is not agent/issue-*.
  const api2 = makeApi([[42, { number: 42, state: "open", labels: [label("state:in-review")] }]]);
  const r2 = await capture(api2.fetch, event("changes_requested", { headRef: "feature/x", body: "Closes #42" }));
  assert.ok(r2.result.flipped, "body-mapped CHANGES_REQUESTED must flip the issue");
  assert.ok(api2.puts.get(42).includes("state:changes-requested"), "body-mapped flip sets state:changes-requested");

  // mapIssueNumber prefers the branch when both are present and differ.
  assert.equal(mapIssueNumber("agent/issue-99", "Closes #42"), 99, "branch mapping takes precedence over body");
}

// --- Criterion 2: an APPROVED or COMMENTED review changes no labels. --------
{
  baseEnv();
  for (const s of ["approved", "commented"]) {
    const api = makeApi([[42, { number: 42, state: "open", labels: [label("state:in-review")] }]]);
    const r = await capture(api.fetch, event(s));
    assert.equal(r.error, undefined, `'${s}' review must not error`);
    assert.equal(r.result.flipped, false, `'${s}' review must flip nothing`);
    assert.equal(api.puts.size, 0, `'${s}' review must issue no label write`);
    assert.match(r.logs.join("\n"), /no label change/, `'${s}' review logs the no-op`);
  }
}

// --- Criterion 3: a review on a PR that maps to no issue does nothing and
// the run succeeds, logging the skip. ---------------------------------------
{
  baseEnv();
  const api = makeApi([]); // no issues seeded
  const r = await capture(api.fetch, event("changes_requested", { headRef: "feature/no-issue", body: "Just a fix." }));
  assert.equal(r.error, undefined, "a no-issue PR must not error");
  assert.equal(r.result.flipped, false, "a no-issue PR flips nothing");
  assert.equal(api.puts.size, 0, "a no-issue PR issues no label write");
  assert.match(r.logs.join("\n"), /maps to no issue/, "the skip is logged");
}

// --- Criterion 4: a Request Changes review when the issue is already
// state:changes-requested leaves it unchanged and the run succeeds. ---------
{
  baseEnv();
  const api = makeApi([[42, { number: 42, state: "open", labels: [label("state:changes-requested"), label("priority:high")] }]]);
  const r = await capture(api.fetch, event("changes_requested"));
  assert.equal(r.error, undefined, "an already-changes-requested issue must not error");
  assert.equal(r.result.flipped, false, "an already-changes-requested issue is not re-flipped");
  assert.equal(api.puts.size, 0, "no label write when already changes-requested");
  assert.match(r.logs.join("\n"), /already state:changes-requested/, "the no-op is logged");
}

// --- Criterion 5: a label-update API failure fails the run visibly with a
// one-line error naming the issue — never a silent success. -----------------
{
  baseEnv();
  const issue = { number: 42, state: "open", labels: [label("state:in-review")] };
  const calls = [];
  // A fetch whose PUT returns 403 Forbidden — the label update fails.
  const failPut = async (url, opts = {}) => {
    const { pathname } = new URL(url);
    const method = opts.method || "GET";
    calls.push({ method, pathname });
    const single = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)$/);
    if (method === "GET" && single)
      return { ok: true, status: 200, json: async () => issue, text: async () => "" };
    if (method === "PUT" && single)
      return { ok: false, status: 403, json: async () => ({}), text: async () => "Forbidden" };
    throw new Error(`unexpected: ${method} ${pathname}`);
  };
  const r = await capture(failPut, event("changes_requested"));
  assert.ok(r.error, "a label-update failure must fail the run (never silent success)");
  assert.match(r.error.message, /#42/, "the error names the issue");
  assert.doesNotMatch(r.error.message, /\n/, "the error is a single line, not a multi-line trace");
}

// --- Criterion 6: every criterion above has exactly one test named after it. --
// The plan file carries six acceptance criteria; this counts its own
// `Criterion N` markers and proves there is exactly one per criterion, 1..6.
// It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 6;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each criterion tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `criterion ${n} has a test`);
}

console.log("PASS review-verdict.test.mjs (6 criteria)");
