#!/usr/bin/env node
// archive-closed-plans.test.mjs — the archive sweep, covering acceptance
// criterion 1: a maintenance sweep moves plan files whose issues are CLOSED
// into plan/done/, leaving live plans in place, and only moves files (it never
// commits) so the archive can land as one reviewable commit.
// Zero dependencies. Run:  node scripts/archive-closed-plans.test.mjs

import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- fixture plan dir ----------------------------------------------------
const planDir = await mkdtemp(join(tmpdir(), "archive-test-"));
const plan = (slug) => writeFile(join(planDir, `${slug}.md`), `---\ntitle: ${slug}\npriority: low\nblocked_by: []\n---\nBody.\n\n## Acceptance criteria\n- [ ] x\n`);
await plan("0001-open");       // maps to an OPEN issue -> stays
await plan("0002-closed");     // maps to a CLOSED issue -> archived
await plan("0003-no-issue");   // no matching issue at all -> stays (unknown)
await writeFile(join(planDir, "README.md"), "# not a plan\n");
// A pre-existing archive must be left completely alone (never re-scanned).
await mkdir(join(planDir, "done"), { recursive: true });
await writeFile(join(planDir, "done", "0000-old.md"), "already archived\n");

// --- in-memory GitHub API ------------------------------------------------
const issues = [
  { number: 1, state: "open", pull_request: undefined, body: "b\n\n<!-- plan-id: 0001-open -->" },
  { number: 2, state: "closed", pull_request: undefined, body: "b\n\n<!-- plan-id: 0002-closed -->" },
];
const respond = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
let wrote = false;
globalThis.fetch = async (url, opts = {}) => {
  const { pathname, searchParams } = new URL(url);
  const method = opts.method || "GET";
  if (method !== "GET") wrote = true; // the sweep must never mutate GitHub
  if (method === "GET" && pathname === "/repos/o/r/issues") {
    return respond(Number(searchParams.get("page")) === 1 ? issues : []);
  }
  throw new Error(`unexpected request: ${method} ${url}`);
};

// --- run the sweep -------------------------------------------------------
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_REPOSITORY = "o/r";
process.env.PLAN_DIR = planDir;
const logs = [];
const realLog = console.log;
console.log = (...a) => logs.push(a.join(" "));
try {
  await import(new URL("./archive-closed-plans.mjs", import.meta.url).href);
} finally {
  console.log = realLog;
}

// --- assertions ----------------------------------------------------------
const top = await readdir(planDir);
const done = await readdir(join(planDir, "done"));

// AC1: the closed issue's plan file moved into plan/done/.
assert.ok(!top.includes("0002-closed.md"), "closed plan must leave the active dir");
assert.ok(done.includes("0002-closed.md"), "closed plan must land in plan/done/");

// Live and unknown plans, README, and the pre-existing archive are untouched.
assert.ok(top.includes("0001-open.md"), "an open issue's plan must stay active");
assert.ok(top.includes("0003-no-issue.md"), "a plan with no issue must stay (state unknown)");
assert.ok(top.includes("README.md"), "README is never archived");
assert.ok(done.includes("0000-old.md"), "a pre-existing archive is never re-touched");

// "via a reviewable commit": the sweep only moves files — it makes no GitHub
// writes and creates no commit itself, leaving the diff for human review.
assert.equal(wrote, false, "the sweep must not mutate GitHub");
assert.ok(logs.some((l) => l.includes("ARCHIVE") && l.includes("0002-closed")), "each move is logged");
assert.ok(logs.some((l) => l.includes("reviewable commit")), "the sweep points the human at committing the moves");

console.log("PASS archive-closed-plans.test.mjs (9 assertions)");
