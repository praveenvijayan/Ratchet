#!/usr/bin/env node
// state-label-exclusivity.test.mjs — regression test for the state-label
// exclusivity enforcement (issue #207). Zero dependencies. Run:
//   node scripts/state-label-exclusivity.test.mjs
//
// Drives main() against an in-memory GitHub API. Exactly one test is named
// after each of issue #207's acceptance criteria (AC1–AC5).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "./state-label-exclusivity.mjs";

const label = (name) => ({ name });

// Build a fetch stub for one scenario: GET /issues/207 returns the given labels;
// PUT /issues/207/labels succeeds unless failPut is set (then a 500). Records
// every call so the test can inspect the label rewrite.
function harness(labels, { failPut = false } = {}) {
  const calls = [];
  const respond = (data, status = 200, ok = true) => ({
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname } = new URL(url);
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, pathname, body });
    if (method === "GET" && pathname === "/repos/o/r/issues/207") {
      return respond({ number: 207, labels });
    }
    if (method === "PUT" && pathname === "/repos/o/r/issues/207/labels") {
      return failPut ? respond("server go boom", 500, false) : respond(body.labels.map(label));
    }
    throw new Error(`unexpected request: ${method} ${pathname}`);
  };
  return calls;
}

// Run main() for one added-label scenario with the noise of console.log muted.
async function run(added, labels, opts) {
  const calls = harness(labels, opts);
  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "o/r";
  process.env.ISSUE_NUMBER = "207";
  process.env.ADDED_LABEL = added;
  delete process.env.GITHUB_EVENT_PATH;
  const realLog = console.log;
  console.log = () => {};
  try {
    const result = await main();
    return { result, calls };
  } finally {
    console.log = realLog;
  }
}

const put = (calls) => calls.find((c) => c.method === "PUT" && c.pathname === "/repos/o/r/issues/207/labels");

// #207 AC1: adding a state label to an issue that already carries a different
// one removes the older one, so exactly one state label remains.
{
  const { result, calls } = await run("state:in-progress", [label("state:ready"), label("state:in-progress"), label("priority:high")]);
  const p = put(calls);
  assert.ok(p, "a duplicate state label must trigger a label rewrite");
  assert.ok(p.body.labels.includes("state:in-progress"), "the newest state label is kept");
  assert.ok(!p.body.labels.includes("state:ready"), "the older state label is removed");
  assert.equal(p.body.labels.filter((l) => l.startsWith("state:")).length, 1, "exactly one state label remains");
  assert.deepEqual(result.removed, ["state:ready"], "the removed label is reported");
}

// #207 AC2: the newest label is the truth, and the enforcement never removes the
// only state label an issue has — an issue whose sole state label is the one
// just added is left untouched.
{
  const { result, calls } = await run("state:in-progress", [label("state:in-progress"), label("priority:high")]);
  assert.ok(!put(calls), "a lone state label must not be rewritten or removed");
  assert.equal(result.changed, false, "nothing changes when the added label is already exclusive");
  assert.deepEqual(result.removed, [], "no state label is removed");
}

// #207 AC3: non-state labels are never touched — adding a non-state label is a
// no-op, and when a removal does happen the non-state labels survive it.
{
  const noop = await run("priority:high", [label("state:ready"), label("priority:high")]);
  assert.ok(!put(noop.calls), "adding a non-state label triggers no rewrite");
  assert.equal(noop.result.changed, false, "a non-state label never causes enforcement");

  const removal = await run("state:in-progress", [label("state:ready"), label("state:in-progress"), label("priority:high"), label("herd")]);
  const p = put(removal.calls);
  assert.ok(p.body.labels.includes("priority:high") && p.body.labels.includes("herd"), "non-state labels survive a state-label removal");
}

// #207 AC4: an enforcement API failure fails the run visibly naming the issue —
// never a silent success leaving the dual state.
{
  const calls = harness([label("state:ready"), label("state:in-progress"), label("priority:high")], { failPut: true });
  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "o/r";
  process.env.ISSUE_NUMBER = "207";
  process.env.ADDED_LABEL = "state:in-progress";
  delete process.env.GITHUB_EVENT_PATH;
  const realLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(main(), /#207/, "a failed label update must reject with an error naming the issue");
  } finally {
    console.log = realLog;
  }
  void calls;
}

// #207 AC5: every criterion above has exactly one test named after it — this
// file declares AC1–AC4 once each, no padding.
{
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (const ac of ["AC1", "AC2", "AC3", "AC4"]) {
    const hits = (self.match(new RegExp(`#207 ${ac}:`, "g")) || []).length;
    assert.equal(hits, 1, `#207 ${ac} has exactly one test named after it`);
  }
}

console.log("PASS state-label-exclusivity.test.mjs");
