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
import { COMMENT_MARKER, runCheck, upsertComment } from "./retroactive-plans.mjs";

const planSync = fileURLToPath(new URL("./plan-sync.mjs", import.meta.url));

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
// #56 AC2: labels that would corrupt the state machine are never applied from
// plan frontmatter, while ordinary custom labels still pass through.
await writeFile(join(planDir, "0082-reserved-labels.md"), `---
title: Reserved labels are filtered
priority: high
labels: [state:ready, priority:P1, workflow:sync]
blocked_by: []
---
Body of 0082.

## Acceptance criteria
- [ ] reserved labels are ignored
`);
// #85: GitHub label names are case-insensitive, so reserved state:/priority:
// prefixes must be filtered in any letter case. Ordinary custom labels are
// still applied exactly as authored.
await writeFile(join(planDir, "0083-case-reserved-labels.md"), `---
title: Case reserved labels are filtered
priority: medium
labels: [State:blocked, PRIORITY:P1, Team:Ops]
blocked_by: []
---
Body of 0083.

## Acceptance criteria
- [ ] mixed-case reserved labels are ignored
`);

// AC5 fixture (#375): a plan file whose slug is already carried by a CLOSED
// issue (the file-still-live-after-merge path) must not be re-created on sync.
await writeFile(join(planDir, "0091-closed-live.md"), `---
title: Slug already carried by a closed issue
priority: high
blocked_by: []
---
Body of 0091.

## Acceptance criteria
- [ ] never re-created because a closed issue already carries the slug
`);
// AC4 fixture (#375): a slug carried by more than one existing issue must not
// gain a third — the sync creates nothing for it and warns, naming every dup.
await writeFile(join(planDir, "0094-dup.md"), `---
title: Slug carried by two issues already
priority: high
blocked_by: []
---
Body of 0094.

## Acceptance criteria
- [ ] no third issue is ever created for this slug
`);

// #471 AC2 fixtures: one plan whose slug already names a live branch (the
// retroactive shape), and one that matches too but carries a human approval.
await writeFile(join(planDir, "0196-no-retroactive-plans.md"), `---
title: Flag retroactive plans
priority: medium
blocked_by: []
---
## Acceptance criteria
- [ ] held at draft until a human approves it
`);
await writeFile(join(planDir, "0198-approved-spike.md"), `---
title: Write up the approved spike
priority: medium
blocked_by: []
retroactive_ok: spike landed first, written up on purpose
---
## Acceptance criteria
- [ ] syncs ready because a human approved it
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
  // AC5 seed (#375): a CLOSED issue already carrying the 0091-closed-live slug.
  [91, { number: 91, state: "closed", title: "Closed, slug still live", labels: [], body: "Merged body\n\n<!-- plan-id: 0091-closed-live -->" }],
  // AC4 seed (#375): two OPEN issues both carrying the 0094-dup slug.
  [92, { number: 92, state: "open", title: "Dup A", labels: [label("state:ready"), label("priority:P1")], body: "Body A\n\n<!-- plan-id: 0094-dup -->" }],
  [93, { number: 93, state: "open", title: "Dup B", labels: [label("state:ready"), label("priority:P1")], body: "Body B\n\n<!-- plan-id: 0094-dup -->" }],
]);
const comments = [];   // #471 audit trail: { issue, body }
let nextNumber = 200;
const respond = (data, status = 200) => ({ ok: true, status, json: async () => data, text: async () => JSON.stringify(data) });

globalThis.fetch = async (url, opts = {}) => {
  const { pathname, searchParams } = new URL(url);
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (method === "GET" && pathname === "/repos/o/r/issues") {
    return respond(Number(searchParams.get("page")) === 1 ? [...issues.values()] : []);
  }
  // #471: the sync reads live branches and open PRs to spot retroactive plans.
  if (method === "GET" && pathname === "/repos/o/r/branches") {
    const live = [{ name: "main" }, { name: "spike/no-retroactive-plans" }, { name: "spike/approved-spike" }];
    return respond(Number(searchParams.get("page")) === 1 ? live : []);
  }
  if (method === "GET" && pathname === "/repos/o/r/pulls") return respond([]);
  const issueComments = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments$/);
  if (method === "GET" && issueComments) {
    const forIssue = comments.filter((c) => c.issue === Number(issueComments[1]));
    return respond(Number(searchParams.get("page")) === 1 ? forIssue : []);
  }
  if (method === "POST" && issueComments) {
    comments.push({ issue: Number(issueComments[1]), body: body.body });
    return respond({ id: comments.length }, 201);
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

// #56 AC2: labels entries beginning state: or priority: are never applied to
// the issue and produce a warning naming the file.
const reservedLabels = [...issues.values()].find((i) => i.body.includes("plan-id: 0082-reserved-labels"));
assert.ok(reservedLabels, "0082-reserved-labels issue was created");
assert.ok(names(reservedLabels).includes("state:ready"), `0082 should keep its computed state, got: ${names(reservedLabels)}`);
assert.equal(names(reservedLabels).filter((name) => name === "state:ready").length, 1, `0082 must not apply frontmatter state labels, got: ${names(reservedLabels)}`);
assert.ok(names(reservedLabels).includes("priority:high"), `0082 should keep its computed priority, got: ${names(reservedLabels)}`);
assert.ok(names(reservedLabels).includes("workflow:sync"), `0082 should keep ordinary custom labels, got: ${names(reservedLabels)}`);
assert.ok(!names(reservedLabels).includes("priority:P1"), `0082 must drop frontmatter priority labels, got: ${names(reservedLabels)}`);
assert.ok(
  logs.some((l) => l.includes("WARNING") && l.includes("0082-reserved-labels.md") && l.includes("state:ready")),
  "reserved state labels must warn, naming the file",
);
assert.ok(
  logs.some((l) => l.includes("WARNING") && l.includes("0082-reserved-labels.md") && l.includes("priority:P1")),
  "reserved priority labels must warn, naming the file",
);

// #85 AC1: frontmatter labels matching a reserved prefix in any letter case are
// dropped with the warning naming the file.
const caseReservedLabels = [...issues.values()].find((i) => i.body.includes("plan-id: 0083-case-reserved-labels"));
assert.ok(caseReservedLabels, "0083-case-reserved-labels issue was created");
assert.ok(names(caseReservedLabels).includes("state:ready"), `0083 should keep its computed state, got: ${names(caseReservedLabels)}`);
assert.ok(!names(caseReservedLabels).includes("State:blocked"), `0083 must drop mixed-case frontmatter state labels, got: ${names(caseReservedLabels)}`);
assert.ok(!names(caseReservedLabels).includes("PRIORITY:P1"), `0083 must drop mixed-case frontmatter priority labels, got: ${names(caseReservedLabels)}`);
assert.ok(
  logs.some((l) => l.includes("WARNING") && l.includes("0083-case-reserved-labels.md") && l.includes("State:blocked")),
  "mixed-case reserved state labels must warn, naming the file",
);
assert.ok(
  logs.some((l) => l.includes("WARNING") && l.includes("0083-case-reserved-labels.md") && l.includes("PRIORITY:P1")),
  "mixed-case reserved priority labels must warn, naming the file",
);

// #85 AC2: non-reserved labels keep their original case when applied.
assert.ok(names(caseReservedLabels).includes("Team:Ops"), `0083 should preserve ordinary custom label case, got: ${names(caseReservedLabels)}`);

// --- #471: plans whose work already exists -------------------------------
// AC2: a plan matching a live branch syncs state:draft — unpickable — until a
// human approves it in the plan file; both the hold and the approval leave an
// audit comment on the issue, and the mechanism is documented for authors.
const commentsOn = (issue) => comments.filter((c) => c.issue === issue.number).map((c) => c.body);
{
  const flagged = [...issues.values()].find((i) => i.body.includes("plan-id: 0196-no-retroactive-plans"));
  const approved = [...issues.values()].find((i) => i.body.includes("plan-id: 0198-approved-spike"));
  assert.ok(names(flagged).includes("state:draft"), `0196 matches branch spike/no-retroactive-plans, so it must sync draft, got: ${names(flagged)}`);
  assert.ok(names(approved).includes("state:ready"), `0198 carries retroactive_ok, so it must sync ready, got: ${names(approved)}`);
  const [flagNote, ...extraFlagNotes] = commentsOn(flagged);
  assert.equal(extraFlagNotes.length, 0, "a flagged issue carries exactly one audit comment");
  assert.ok(flagNote.includes("ratchet:retroactive:0196-no-retroactive-plans:flagged"), "the audit comment is marked so re-syncs never duplicate it");
  assert.ok(/state:draft/.test(flagNote) && /retroactive_ok/.test(flagNote), `the audit comment must state the hold and how to approve, got:\n${flagNote}`);
  const [okNote, ...extraOkNotes] = commentsOn(approved);
  assert.equal(extraOkNotes.length, 0, "an approved issue records the approval once");
  assert.ok(/approved/i.test(okNote) && /spike landed first/.test(okNote), `the approval audit must quote the human's reason, got:\n${okNote}`);
  assert.ok(
    logs.some((l) => l.includes("WARNING") && l.includes("already exists")),
    "the sync says loudly that a plan was held for matching existing work",
  );
}

// #471 AC3: a plan matching no branch and no PR syncs exactly as before — ready
// (asserted above), with no retroactive comment on its issue.
assert.deepEqual(commentsOn(withSections), [], `an unmatched plan gets no retroactive comment, got: ${JSON.stringify(commentsOn(withSections))}`);

// #471 AC1 + AC4: the planning-PR check compares each ADDED plan file against
// open branches and PRs, and posts one comment naming the plan file, the
// branch/PR it matched, and the text that matched — never a bare failure.
{
  const planTexts = {
    "plan/0196-no-retroactive-plans.md": "---\ntitle: Flag retroactive plans\npriority: medium\n---\nBody.\n",
    "plan/0197-fresh-idea.md": "---\ntitle: Add a wholly unrelated widget exporter\npriority: low\n---\nBody.\n",
  };
  const page1 = (path, rows) => (path.includes("page=1") ? rows : []);
  const postedOnPr = [];
  const checkGh = async (method, path, body) => {
    if (path.startsWith("/repos/o/r/pulls/500/files")) return page1(path, [
      { status: "added", filename: "plan/0196-no-retroactive-plans.md" },
      { status: "added", filename: "plan/0197-fresh-idea.md" },
      { status: "modified", filename: "plan/0100-old.md" },
    ]);
    if (path === "/repos/o/r/pulls/500") return { number: 500, head: { ref: "ratchet/planning" } };
    if (path.startsWith("/repos/o/r/branches")) return page1(path, [{ name: "main" }, { name: "ratchet/planning" }, { name: "spike/no-retroactive-plans" }]);
    if (path.startsWith("/repos/o/r/pulls?state=open")) return page1(path, [
      { number: 229, title: "Spike: skip the plan step", body: "Prototype for plan/0196-no-retroactive-plans.md\nnothing else", head: { ref: "spike/quick-experiment" } },
      { number: 500, title: "plan: flag retroactive plans", body: "the planning PR itself", head: { ref: "ratchet/planning" } },
    ]);
    if (method === "GET" && path.startsWith("/repos/o/r/issues/500/comments")) return [];
    if (method === "POST" && path === "/repos/o/r/issues/500/comments") { postedOnPr.push(body.body); return { id: 1 }; }
    throw new Error(`unexpected request: ${method} ${path}`);
  };

  const check = await runCheck({ gh: checkGh, repo: "o/r", prNumber: 500, readPlan: async (f) => planTexts[f] });
  const flaggedFiles = check.flags.map((f) => f.file);
  assert.deepEqual(flaggedFiles, ["plan/0196-no-retroactive-plans.md"], `only the plan matching existing work is flagged, got: ${flaggedFiles}`);
  const matched = check.flags[0].matches.map((m) => m.label);
  assert.ok(matched.some((l) => l.includes("spike/no-retroactive-plans")) && matched.some((l) => l.includes("PR #229")), `the matching branch and PR must both be named, got: ${matched}`);
  assert.ok(!matched.some((l) => l.includes("PR #500")), `the planning PR must never flag its own plans, got: ${matched}`);

  await upsertComment(checkGh, "o/r", 500, check.comment, { createIfMissing: check.flags.length > 0 });
  assert.equal(postedOnPr.length, 1, `the check posts exactly one comment, got ${postedOnPr.length}`);
  const report = postedOnPr[0];
  assert.ok(report.includes(COMMENT_MARKER) && report.includes("plan/0196-no-retroactive-plans.md"), "the comment is marked and names the flagged plan file");
  assert.ok(!report.includes("0197-fresh-idea"), "the comment never names an unflagged plan");
  // AC4: every line names the field it matched on and quotes the matching text.
  assert.match(report, /plan slug `0196-no-retroactive-plans` matches the branch name of branch `spike\/no-retroactive-plans`/, `each match names what matched and where, got:\n${report}`);
  assert.ok(report.includes("Prototype for plan/0196-no-retroactive-plans.md"), "a PR-body match quotes the matching line");
  assert.ok(report.includes("state:draft") && report.includes("retroactive_ok"), "the report states the consequence and how a human approves");
}

// #56 AC1: a sync that skipped any plan file for invalid frontmatter finishes
// as a visible failure, not a green run.
const invalidDir = await mkdtemp(join(tmpdir(), "plan-sync-invalid-"));
await writeFile(join(invalidDir, "0077-bad-priority.md"), `---
title: Has a bogus priority
priority: P3
blocked_by: []
---
Body of 0077.

## Acceptance criteria
- [ ] never created
`);
let invalidExit = 0;
let invalidErr = "";
try {
  execFileSync(process.execPath, [planSync], {
    cwd: invalidDir, // avoid loading the repo's .env; validation fails before network calls
    env: { GITHUB_TOKEN: "test-token", GITHUB_REPOSITORY: "o/r", PLAN_DIR: invalidDir, PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  invalidExit = e.status ?? 1;
  invalidErr = `${e.stderr || ""}${e.stdout || ""}`;
}
assert.ok(invalidExit !== 0, "invalid frontmatter must exit non-zero");
assert.ok(/invalid plan frontmatter/i.test(invalidErr), `invalid frontmatter error must say so loudly, got: ${invalidErr}`);
assert.ok(/0077-bad-priority/.test(invalidErr) && /P3/.test(invalidErr), `invalid frontmatter error must name the file and value, got: ${invalidErr}`);

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

// #56 AC3: a blocked_by cycle whose edges span live files and marker-resolved
// issues is detected and reported loudly before any mutation.
const markerCycleDir = await mkdtemp(join(tmpdir(), "plan-sync-marker-cycle-"));
await writeFile(join(markerCycleDir, "0100-live-a.md"), `---
title: Live A
priority: medium
blocked_by: [0099-marker-b]
---
Body of A.

## Acceptance criteria
- [ ] a
`);
const markerCycleScript = `
  const label = (name) => ({ name });
  const issues = [
    { number: 1, state: "open", title: "Marker B", labels: [label("state:blocked")], body: "B body\\n\\nBlocked by #2\\n\\n<!-- plan-id: 0099-marker-b -->" },
    { number: 2, state: "open", title: "Live A", labels: [label("state:ready")], body: "A body\\n\\n<!-- plan-id: 0100-live-a -->" },
  ];
  const respond = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = opts.method || "GET";
    if (method === "GET" && pathname === "/repos/o/r/issues") {
      return respond(Number(searchParams.get("page")) === 1 ? issues : []);
    }
    throw new Error("unexpected mutation before cycle gate: " + method + " " + url);
  };
  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "o/r";
  process.env.PLAN_DIR = ${JSON.stringify(markerCycleDir)};
  await import(${JSON.stringify(new URL("./plan-sync.mjs", import.meta.url).href)});
`;
let markerCycleExit = 0;
let markerCycleErr = "";
try {
  execFileSync(process.execPath, ["--input-type=module", "-e", markerCycleScript], {
    cwd: markerCycleDir,
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  markerCycleExit = e.status ?? 1;
  markerCycleErr = `${e.stderr || ""}${e.stdout || ""}`;
}
assert.ok(markerCycleExit !== 0, "marker-resolved blocked_by cycle must exit non-zero");
assert.ok(/cycle/i.test(markerCycleErr), `marker-resolved cycle error must say so loudly, got: ${markerCycleErr}`);
assert.ok(/0100-live-a/.test(markerCycleErr) && /0099-marker-b/.test(markerCycleErr), `marker-resolved cycle error must name every slug, got: ${markerCycleErr}`);

// #375 AC5: the 0091-closed-live plan is already carried by CLOSED issue #91, so
// the sync re-creates nothing for that slug — exactly one issue carries it, and
// it is the pre-existing closed one.
const closedLive = [...issues.values()].filter((i) => (i.body || "").includes("plan-id: 0091-closed-live"));
assert.equal(closedLive.length, 1, `a closed issue's slug must suppress re-creation, found ${closedLive.length} issues`);
assert.equal(closedLive[0].number, 91, "the sole issue for a closed-issue slug must be the pre-existing one, not a new one");

// #375 AC4: the 0094-dup slug is already carried by #92 and #93. The sync must
// create no third issue and must warn, naming every duplicate issue number.
const dupIssues = [...issues.values()].filter((i) => (i.body || "").includes("plan-id: 0094-dup"));
assert.equal(dupIssues.length, 2, `a slug carried by two issues must gain no third, found ${dupIssues.length}`);
assert.ok(
  logs.some((l) => l.includes("WARNING") && l.includes("0094-dup") && l.includes("#92") && l.includes("#93")),
  "a duplicated slug must warn, naming every duplicate issue number",
);

// #375 AC3: running the sync twice against an unchanged plan tree and issue set
// creates zero issues on the second run — including for a plan file whose body
// quotes the marker syntax in prose (the #345/#349/#356 shape). Run in a
// subprocess so the module body executes once and the exported main() drives the
// second sync against the same in-memory issue store. Under the old first-match
// parser the appended real marker was shadowed by the quoted placeholder, so
// every run created a fresh issue; last-match makes the second run a no-op.
const ac3Dir = await mkdtemp(join(tmpdir(), "plan-sync-idem-"));
await writeFile(join(ac3Dir, "0095-quotes-marker.md"), `---
title: Quotes the marker syntax in prose
priority: high
blocked_by: []
---
This plan mentions the \`<!-- plan-id: 0000-example-placeholder -->\` marker in prose.

## Acceptance criteria
- [ ] idempotent across two runs despite quoting the marker syntax
`);
const ac3Script = `
  const issues = [];
  let nextNumber = 1;
  const label = (name) => ({ name });
  const respond = (data, status = 200) => ({ ok: true, status, json: async () => data, text: async () => JSON.stringify(data) });
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (method === "GET" && pathname === "/repos/o/r/issues") {
      return respond(Number(searchParams.get("page")) === 1 ? issues.slice() : []);
    }
    if (method === "POST" && pathname === "/repos/o/r/issues") {
      const issue = { number: nextNumber++, state: "open", title: body.title, body: body.body, labels: (body.labels || []).map(label) };
      issues.push(issue);
      return respond(issue, 201);
    }
    const patch = pathname.match(/^\\/repos\\/o\\/r\\/issues\\/(\\d+)$/);
    if (method === "PATCH" && patch) {
      const issue = issues.find((i) => i.number === Number(patch[1]));
      Object.assign(issue, { title: body.title, body: body.body, labels: body.labels.map(label) });
      return respond(issue);
    }
    throw new Error("unexpected request: " + method + " " + url);
  };
  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "o/r";
  process.env.PLAN_DIR = ${JSON.stringify(ac3Dir)};
  const mod = await import(${JSON.stringify(new URL("./plan-sync.mjs", import.meta.url).href)});
  const afterRun1 = issues.length;
  if (afterRun1 !== 1) { console.error("run 1 must create exactly one issue, got " + afterRun1); process.exit(2); }
  await mod.main();
  if (issues.length !== afterRun1) { console.error("run 2 created " + (issues.length - afterRun1) + " issue(s); sync is not idempotent"); process.exit(3); }
  console.log("AC3-OK");
`;
let ac3Exit = 0;
let ac3Out = "";
try {
  ac3Out = execFileSync(process.execPath, ["--input-type=module", "-e", ac3Script], {
    cwd: ac3Dir,
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
} catch (e) {
  ac3Exit = e.status ?? 1;
  ac3Out = `${e.stdout || ""}${e.stderr || ""}`;
}
assert.equal(ac3Exit, 0, `a second sync run must create no issues; got exit ${ac3Exit}: ${ac3Out}`);
assert.match(ac3Out, /AC3-OK/, "two-run idempotency check must reach its success marker");

console.log("PASS plan-sync.test.mjs");
