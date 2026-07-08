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
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// --- fixture plan dir --------------------------------------------------
const planDir = await mkdtemp(join(tmpdir(), "plan-sync-test-"));
await writeFile(join(planDir, "0036-existing.md"), `---
title: Existing issue gains new blockers
priority: high
blocked_by: [0063-new-blocker, 0001-removed-plan, 0999-typo]
---
Body of 0036.

## Acceptance criteria
- [ ] something
`);
// Valid priority, but deliberately (a) omits the required blocked_by and (b)
// carries an unknown key — both must warn without blocking the sync.
await writeFile(join(planDir, "0063-new-blocker.md"), `---
title: Brand-new blocker
priority: medium
owner: nobody
---
Body of 0063.

## Acceptance criteria
- [ ] something else
`);
// Invalid priority: must be skipped (never created) with a loud warning that
// names the file and the offending value.
await writeFile(join(planDir, "0077-bad-priority.md"), `---
title: Has a bogus priority
priority: P3
blocked_by: []
---
Body of 0077.

## Acceptance criteria
- [ ] never created
`);
// #21 AC3: a plan whose only blocker was ARCHIVED (its file moved to plan/done/,
// its issue CLOSED) must still resolve the link through the closed issue's
// marker — and, being closed, that blocker must not force state:blocked.
await writeFile(join(planDir, "0088-depends-on-archived.md"), `---
title: Depends on an archived plan
priority: low
blocked_by: [0002-archived-closed]
---
Body of 0088.

## Acceptance criteria
- [ ] something
`);
// #21 AC2: plan-sync must ignore plan/done/ entirely — a plan file parked there
// is never scanned and never becomes an issue.
await mkdir(join(planDir, "done"), { recursive: true });
await writeFile(join(planDir, "done", "0099-archived.md"), `---
title: Already archived, must be ignored
priority: high
blocked_by: []
---
Body of 0099.

## Acceptance criteria
- [ ] must never be synced
`);
// Issue #18: a plan carrying the optional ## Non-functional and ## Test notes
// sections (in addition to acceptance criteria) must compile to state:ready and
// carry both sections into the issue body verbatim.
await writeFile(join(planDir, "0080-with-sections.md"), `---
title: Has non-functional and test notes
priority: medium
blocked_by: []
---
Body of 0080.

## Acceptance criteria
- [ ] core behaviour works

## Non-functional
- p95 latency under 200 ms

## Test notes
- exercise the retry path under simulated network loss
`);
// Issue #18 regression: the new sections are inert to the readiness rule. A
// plan whose only checkboxes sit under ## Test notes, with NO ## Acceptance
// criteria block, must still land as state:draft — exactly as before.
await writeFile(join(planDir, "0081-testnotes-only.md"), `---
title: Test notes but no criteria
priority: low
blocked_by: []
---
Body of 0081.

## Test notes
- [ ] this checkbox is not an acceptance criterion
`);

// --- in-memory GitHub API ----------------------------------------------
const label = (name) => ({ name });
const issues = new Map([
  // Issue whose plan file is gone: must still resolve via its marker.
  [10, { number: 10, state: "open", title: "Removed plan", labels: [label("state:ready"), label("priority:P2")], body: "Old body\n\n<!-- plan-id: 0001-removed-plan -->" }],
  // Archived blocker: its plan file lives in plan/done/, its issue is CLOSED.
  [12, { number: 12, state: "closed", title: "Archived", labels: [], body: "Old body\n\n<!-- plan-id: 0002-archived-closed -->" }],
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

// Criterion 1 + 4: an invalid priority is skipped (never created) with a loud
// warning naming the file and the offending value.
const badPriority = [...issues.values()].find((i) => i.body.includes("plan-id: 0077-bad-priority"));
assert.ok(!badPriority, "0077 with invalid priority must never be created");
assert.ok(
  logs.some((l) => l.includes("WARNING") && l.includes("0077-bad-priority") && l.includes("P3")),
  "invalid priority must be warned about loudly, naming the file and the value",
);

// Criterion 2: a missing blocked_by warns (naming the file) but does not block
// the sync — 0063 is still created and ready.
assert.ok(
  logs.some((l) => l.includes("WARNING") && l.includes("0063-new-blocker") && l.includes("blocked_by")),
  "missing blocked_by must be warned about, naming the file",
);

// Criterion 3: an unknown frontmatter key warns but does not block the sync.
assert.ok(
  logs.some((l) => l.includes("WARNING") && l.includes("0063-new-blocker") && l.includes("owner")),
  "unknown frontmatter key must be warned about, naming the file and key",
);

// #21 AC3: a blocked_by pointing at an archived (closed-issue) slug resolves
// through the marker, so the new issue links `Blocked by #12`; and because that
// blocker is closed, the issue is not frozen — it lands state:ready.
const dependsOnArchived = [...issues.values()].find((i) => i.body.includes("plan-id: 0088-depends-on-archived"));
assert.ok(dependsOnArchived, "0088 issue was created");
assert.ok(dependsOnArchived.body.includes("Blocked by #12"), "an archived slug must still resolve to its closed issue via the marker");
assert.ok(names(dependsOnArchived).includes("state:ready"), `a closed blocker must not freeze the issue, got: ${names(dependsOnArchived)}`);

// #21 AC2: nothing in plan/done/ is ever scanned — 0099 never becomes an issue.
const archivedSynced = [...issues.values()].find((i) => (i.body || "").includes("plan-id: 0099-archived"));
assert.ok(!archivedSynced, "a plan file in plan/done/ must never be synced");

// Issue #18: optional ## Non-functional and ## Test notes sections compile to a
// ready issue and are carried into the body verbatim (no compiler change).
const withSections = [...issues.values()].find((i) => i.body.includes("plan-id: 0080-with-sections"));
assert.ok(withSections, "0080-with-sections issue was created");
assert.ok(names(withSections).includes("state:ready"), `0080 should be ready, got: ${names(withSections)}`);
assert.ok(withSections.body.includes("## Non-functional"), "0080 body must carry the ## Non-functional section verbatim");
assert.ok(withSections.body.includes("## Test notes"), "0080 body must carry the ## Test notes section verbatim");

// Issue #18 regression: the sections are inert to the readiness rule. Checkboxes
// living only under ## Test notes (no ## Acceptance criteria block) must NOT make
// the issue pickable — it stays state:draft, exactly as before the sections existed.
const notesOnly = [...issues.values()].find((i) => i.body.includes("plan-id: 0081-testnotes-only"));
assert.ok(notesOnly, "0081-testnotes-only issue was created");
assert.ok(
  names(notesOnly).includes("state:draft"),
  `0081 must stay draft: ## Test notes checkboxes must not fake acceptance criteria, got: ${names(notesOnly)}`,
);

// --- blocked_by cycle gate ----------------------------------------------
// A two-file cycle (each blocked_by the other) is a deadlock: sync must fail
// loudly, naming every slug, and change nothing. Run as a subprocess because
// the gate ends the process with a non-zero exit; the gate runs before any
// network call, so a dummy token/repo and no fetch mock are enough.
const cycleDir = await mkdtemp(join(tmpdir(), "plan-sync-cycle-"));
await writeFile(join(cycleDir, "0005-a.md"), `---
title: Plan A
priority: medium
blocked_by: [0006-b]
---
Body of A.

## Acceptance criteria
- [ ] a
`);
await writeFile(join(cycleDir, "0006-b.md"), `---
title: Plan B
priority: medium
blocked_by: [0005-a]
---
Body of B.

## Acceptance criteria
- [ ] b
`);
const planSync = fileURLToPath(new URL("./plan-sync.mjs", import.meta.url));
let cycleExit = 0;
let cycleErr = "";
try {
  execFileSync(process.execPath, [planSync], {
    cwd: cycleDir, // avoid loading the repo's .env; the gate makes no network call anyway
    env: { GITHUB_TOKEN: "test-token", GITHUB_REPOSITORY: "o/r", PLAN_DIR: cycleDir, PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  cycleExit = e.status ?? 1;
  cycleErr = `${e.stderr || ""}${e.stdout || ""}`;
}
assert.ok(cycleExit !== 0, "plan-sync must exit non-zero on a blocked_by cycle");
assert.ok(/cycle/i.test(cycleErr), `cycle error must say so loudly, got: ${cycleErr}`);
assert.ok(/0005-a/.test(cycleErr) && /0006-b/.test(cycleErr), `cycle error must name every slug, got: ${cycleErr}`);

console.log("PASS plan-sync.test.mjs (23 assertions)");
