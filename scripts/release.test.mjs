#!/usr/bin/env node
// release.test.mjs — regression test for the opt-in release lane.
// Zero dependencies. Run:  node scripts/release.test.mjs
//
// Covers the acceptance criteria of the release lane:
//   1. tags the next version and builds a changelog from merged PR titles
//   2. safe default — the workflow job is gated on RATCHET_RELEASE
//   4. no merges since the last tag exits cleanly with a message, not an error
// plus the first-ever-release edge and the invalid-bump error path.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "./release.mjs";

const respond = (data, status = 200) => ({ ok: true, status, json: async () => data, text: async () => JSON.stringify(data) });
const notFound = () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "Not Found" });

// Build an in-memory GitHub API. `latest` is the /releases/latest payload (or
// null for a 404 — no releases yet); `pulls` is page 1 of closed PRs; created
// releases are captured for assertions.
function mockGitHub({ latest, pulls }) {
  const created = [];
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (method === "GET" && pathname === "/repos/o/r/releases/latest") {
      return latest === null ? notFound() : respond(latest);
    }
    if (method === "GET" && pathname === "/repos/o/r/pulls") {
      return respond(Number(searchParams.get("page")) === 1 ? pulls : []);
    }
    if (method === "POST" && pathname === "/repos/o/r/releases") {
      created.push(body);
      return respond({ ...body, html_url: `https://github.com/o/r/releases/tag/${body.tag_name}` }, 201);
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
  return created;
}

process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_REPOSITORY = "o/r";

// --- 1. tags the next version and builds a changelog from PR titles ---------
process.env.RELEASE_BUMP = "minor";
let created = mockGitHub({
  latest: { tag_name: "v1.2.3", published_at: "2026-01-01T00:00:00Z" },
  pulls: [
    { number: 42, title: "Add feature X", merged_at: "2026-02-01T00:00:00Z" },
    { number: 41, title: "Fix bug Y", merged_at: "2026-01-15T00:00:00Z" },
    { number: 40, title: "Old thing before the tag", merged_at: "2025-12-01T00:00:00Z" },
    { number: 39, title: "Never merged", merged_at: null },
  ],
});
let result = await main();
assert.equal(result.released, true, "a batch of merged PRs must produce a release");
assert.equal(created.length, 1, "exactly one release is created");
assert.equal(created[0].tag_name, "v1.3.0", `minor bump of v1.2.3 must be v1.3.0, got ${created[0].tag_name}`);
assert.ok(created[0].body.includes("Add feature X (#42)"), "changelog must list a merged PR by title and number");
assert.ok(created[0].body.includes("Fix bug Y (#41)"), "changelog must list every PR merged since the last tag");
assert.ok(!created[0].body.includes("Old thing"), "PRs merged before the last tag are excluded");
assert.ok(!created[0].body.includes("Never merged"), "unmerged PRs are excluded");

// --- 4. no merges since the last tag: clean exit, a message, no error --------
process.env.RELEASE_BUMP = "patch";
created = mockGitHub({
  latest: { tag_name: "v1.3.0", published_at: "2026-03-01T00:00:00Z" },
  pulls: [{ number: 50, title: "Merged long ago", merged_at: "2026-02-01T00:00:00Z" }],
});
const logs = [];
const realLog = console.log;
console.log = (...a) => logs.push(a.join(" "));
try {
  result = await main();
} finally {
  console.log = realLog;
}
assert.equal(result.released, false, "no PRs since the tag means nothing is released");
assert.equal(created.length, 0, "no release is created when there is nothing to ship");
assert.ok(logs.some((l) => l.includes("Nothing to release")), "a clear 'nothing to release' message is printed");

// --- first-ever release: no prior tag (404) starts from v0.0.0 ---------------
process.env.RELEASE_BUMP = "patch";
created = mockGitHub({
  latest: null,
  pulls: [{ number: 1, title: "Initial commit of the thing", merged_at: "2026-01-01T00:00:00Z" }],
});
result = await main();
assert.equal(created[0].tag_name, "v0.0.1", `first release with no prior tag must bump from v0.0.0, got ${created[0].tag_name}`);
assert.ok(created[0].body.includes("Initial commit of the thing (#1)"), "first changelog includes all merged PRs");

// --- invalid bump: a clear error, not a stack trace --------------------------
process.env.RELEASE_BUMP = "sideways";
mockGitHub({ latest: null, pulls: [] });
await assert.rejects(
  () => main(),
  (e) => e.message.includes("sideways") && e.message.includes("major, minor, or patch"),
  "an invalid RELEASE_BUMP is rejected with a message naming the valid values",
);
delete process.env.RELEASE_BUMP;

// --- 2. safe default: the workflow job is gated on RATCHET_RELEASE -----------
const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url)), "utf8");
assert.ok(workflow.includes("vars.RATCHET_RELEASE == 'true'"), "the release job must be gated on RATCHET_RELEASE (off by default)");
assert.ok(workflow.includes("workflow_dispatch"), "the release lane runs on demand");

console.log("PASS release.test.mjs (13 assertions)");
