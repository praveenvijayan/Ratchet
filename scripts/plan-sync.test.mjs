#!/usr/bin/env node
// plan-sync.test.mjs — regression test for blocker resolution ordering.
// Zero dependencies. Run:  node scripts/plan-sync.test.mjs
//
// Guards the first-sync ordering bug: an existing editable issue whose plan
// file gains `blocked_by` on a brand-new, higher-sorting plan file must end
// up with both the `Blocked by #N` line AND state:blocked after a single
// run. Also covers blockers on issues whose plan file no longer exists, and
// the loud warning for slugs that resolve to nothing.

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- fixture plan dir --------------------------------------------------
const planDir = await mkdtemp(join(tmpdir(), "plan-sync-test-"));
await writeFile(join(planDir, "0036-existing.md"), `---
title: Existing issue gains new blockers
priority: P1
blocked_by: [0063-new-blocker, 0001-removed-plan, 0999-typo]
---
Body of 0036.

## Acceptance criteria
- [ ] something
`);
await writeFile(join(planDir, "0063-new-blocker.md"), `---
title: Brand-new blocker
priority: P2
---
Body of 0063.

## Acceptance criteria
- [ ] something else
`);

// --- in-memory GitHub API ----------------------------------------------
const label = (name) => ({ name });
const issues = new Map([
  // Issue whose plan file is gone: must still resolve via its marker.
  [10, { number: 10, state: "open", title: "Removed plan", labels: [label("state:ready"), label("priority:P2")], body: "Old body\n\n<!-- plan-id: 0001-removed-plan -->" }],
  // The editable issue that gains blockers on this sync.
  [68, { number: 68, state: "open", title: "Existing", labels: [label("state:ready"), label("priority:P1")], body: "Old body\n\n<!-- plan-id: 0036-existing -->" }],
]);
let nextNumber = 69;
const respond = (data, status = 200) => ({ ok: true, status, json: async () => data, text: async () => JSON.stringify(data) });

globalThis.fetch = async (url, opts = {}) => {
  const { pathname, searchParams } = new URL(url);
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (method === "GET" && pathname === "/repos/o/r/issues") {
    return respond(Number(searchParams.get("page")) === 1 ? [...issues.values()] : []);
  }
  if (method === "POST" && pathname === "/repos/o/r/issues") {
    const issue = { number: nextNumber++, state: "open", title: body.title, body: body.body, labels: (body.labels || []).map(label) };
    issues.set(issue.number, issue);
    return respond(issue, 201);
  }
  const patch = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)$/);
  if (method === "PATCH" && patch) {
    const issue = issues.get(Number(patch[1]));
    Object.assign(issue, { title: body.title, body: body.body, labels: body.labels.map(label) });
    return respond(issue);
  }
  throw new Error(`unexpected request: ${method} ${url}`);
};

// --- run the sync --------------------------------------------------------
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_REPOSITORY = "o/r";
process.env.PLAN_DIR = planDir;
const logs = [];
const realLog = console.log;
console.log = (...args) => logs.push(args.join(" "));
try {
  await import(new URL("./plan-sync.mjs", import.meta.url).href);
} finally {
  console.log = realLog;
}

// --- assertions ----------------------------------------------------------
const names = (issue) => issue.labels.map((l) => l.name);
const created = [...issues.values()].find((i) => i.body.includes("plan-id: 0063-new-blocker"));
assert.ok(created, "0063-new-blocker issue was created");
assert.ok(names(created).includes("state:ready"), `0063 should be ready, got: ${names(created)}`);

const existing = issues.get(68);
assert.ok(existing.body.includes(`Blocked by #${created.number}`), "0036 must link its brand-new blocker after a single run");
assert.ok(existing.body.includes("Blocked by #10"), "0036 must link the blocker whose plan file is gone");
assert.ok(names(existing).includes("state:blocked"), `0036 should be blocked, got: ${names(existing)}`);
assert.ok(logs.some((l) => l.includes("WARNING") && l.includes("0999-typo")), "unresolved slug must be warned about loudly");

console.log("PASS plan-sync.test.mjs (6 assertions)");
