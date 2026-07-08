#!/usr/bin/env node
// unblock-dependents.test.mjs — regression test for the extracted unblock
// orchestration. Zero dependencies. Run:  node scripts/unblock-dependents.test.mjs
//
// Drives main() against an in-memory GitHub API. Behaviour must match what the
// workflow YAML did: strip the closed issue's own state label; promote a
// dependent whose blockers are all closed to state:ready when it has criteria,
// hold it at state:draft when it does not, and leave a still-blocked dependent
// untouched.

import assert from "node:assert/strict";
import { main } from "./unblock-dependents.mjs";

const label = (name) => ({ name });
// Every issue the API knows about, keyed by number. GET /issues/N reads both
// .state (blocker checks) and .labels (the closed issue's own label strip).
const issues = new Map([
  [4, { number: 4, state: "closed", labels: [label("state:in-review"), label("priority:medium")] }],
  [5, { number: 5, state: "closed", labels: [] }],
  [6, { number: 6, state: "open", labels: [] }],
]);
const open = [
  // All blockers (#4, #5) closed + criteria present -> state:ready.
  { number: 50, labels: [label("state:blocked"), label("priority:medium")], body: "Body.\n\nBlocked by #4\nBlocked by #5\n\n## Acceptance criteria\n- [ ] works\n\n<!-- plan-id: 0050-foo -->" },
  // Blocker #4 closed but NO criteria -> held at state:draft.
  { number: 51, labels: [label("state:blocked"), label("priority:low")], body: "Body.\n\nBlocked by #4\n\n<!-- plan-id: 0051-bar -->" },
  // Blocker #6 still open -> not promoted.
  { number: 52, labels: [label("state:blocked"), label("priority:low")], body: "Body.\n\nBlocked by #4\nBlocked by #6\n\n## Acceptance criteria\n- [ ] later" },
  // Not blocked by the closed issue at all -> ignored.
  { number: 53, labels: [label("state:ready")], body: "Body with no blockers." },
];

const calls = [];
const respond = (data, status = 200) => ({ ok: true, status, json: async () => data, text: async () => JSON.stringify(data) });
globalThis.fetch = async (url, opts = {}) => {
  const { pathname, searchParams } = new URL(url);
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, pathname, body });
  if (method === "GET" && pathname === "/repos/o/r/issues") {
    return respond(Number(searchParams.get("page")) === 1 ? open : []);
  }
  const single = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)$/);
  if (method === "GET" && single) return respond(issues.get(Number(single[1])));
  if (method !== "GET") return respond({}, 200); // PUT labels / POST comment
  throw new Error(`unexpected request: ${method} ${pathname}`);
};

process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_REPOSITORY = "o/r";
process.env.CLOSED_ISSUE = "4";
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
const comment = (n) => calls.find((c) => c.method === "POST" && c.pathname === `/repos/o/r/issues/${n}/comments`);

// The closed issue's own state label is stripped; its other labels survive.
assert.ok(put(4), "the closed issue's labels must be rewritten");
assert.ok(!put(4).body.labels.some((l) => l.startsWith("state:")), "the closed issue must lose its state:* label");
assert.ok(put(4).body.labels.includes("priority:medium"), "the closed issue keeps its non-state labels");

// #50: all blockers closed + criteria -> state:ready with an unblock comment.
assert.ok(put(50)?.body.labels.includes("state:ready"), "#50 with all blockers closed and criteria must become state:ready");
assert.match(comment(50)?.body.body || "", /Unblocked/, "#50 must get an unblock comment");

// #51: all blockers closed but no criteria -> held at state:draft.
assert.ok(put(51)?.body.labels.includes("state:draft"), "#51 without criteria must be held at state:draft");
assert.match(comment(51)?.body.body || "", /acceptance criteria/i, "#51's comment must explain the missing criteria");

// #52: a still-open blocker (#6) means it is not promoted.
assert.ok(!put(52), "#52 with an open blocker must not be promoted");

assert.equal(result.promoted, 2, "exactly two dependents were updated");

console.log("PASS unblock-dependents.test.mjs (9 assertions)");
