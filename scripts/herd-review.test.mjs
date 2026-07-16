#!/usr/bin/env node
// herd-review.test.mjs — the criteria test plan for issue #444 (herd's review
// rework dedup decoupled from the state:changes-requested label and keyed on the
// rejection's own review id instead). One test per acceptance criterion, driven
// through herd-review.mjs's public interface. Offline: gh and spawn are injected,
// so every gh call is recorded to prove the reactor only reads (pr list + pr view,
// never merges/approves/closes/labels). Run: node scripts/herd-review.test.mjs
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewOnce, REVIEW_REWORK_PROMPT, REVIEW_CONFLICT_REWORK_PROMPT } from "./herd-review.mjs";
import { readState } from "./herd-survey.mjs";

// A pr-list survey row carrying mergeability alongside the review decision, the way
// herd-review reads it now — used by the #445 conflict-aware tests.
const prsMerge = (decision, { mergeable, mergeStateStatus } = {}) => () =>
  [{ number: 42, headRefName: "agent/issue-7", reviewDecision: decision, mergeable, mergeStateStatus }];

const NOW = Date.UTC(2026, 6, 10, 12, 0, 0);
const noSpawn = (msg) => () => { throw new Error(msg); };
const writeStateFile = (path, state) => writeFileSync(path, JSON.stringify(state) + "\n");

const mkConfig = (over = {}) => ({
  maxWorkers: 3,
  pollSeconds: 60,
  reworkCap: 2,
  logDir: "logs",
  adapters: { claude: { launch: ["claude", "-p", "{prompt}"], resume: ["claude", "--resume", "{issue}", "{prompt}"], promptTemplate: "issue {issue}", env: {} } },
  routing: { default: "claude", labels: {} },
  ...over,
});

// A tracked, ready-for-review entry for issue #7 / PR #42.
const entry = (over = {}) => ({ adapter: "claude", logFile: "logs/issue-7.log", attempts: 1, status: "ready-for-review", pr: 42, ...over });

// gh stub. `pr list` returns open-PR review decisions; `pr view` returns a PR's
// reviews (the per-rejection detail read), both as thunks so a test can mutate the
// world between polls. Every call is recorded to prove the reactor mutates nothing
// on GitHub and issues no label read.
const mkGh = ({ prs, reviews = () => [], calls, failList = false, failView = false }) => async (args) => {
  calls.push(args);
  const sub = `${args[0]} ${args[1]}`;
  if (sub === "pr list") {
    if (failList) throw new Error("gh pr list boom");
    return prs();
  }
  if (sub === "pr view") {
    if (failView) throw new Error("gh pr view boom");
    return { reviews: reviews() };
  }
  throw new Error(`unexpected gh call: ${args.join(" ")}`);
};

const prsWith = (decision) => () => [{ number: 42, headRefName: "agent/issue-7", reviewDecision: decision }];
const reviewWith = (id, submittedAt = "2026-07-10T00:00:00Z") => () => [{ id, state: "CHANGES_REQUESTED", submittedAt }];

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-review-"));
  const cwd = process.cwd();
  try { process.chdir(dir); return await fn(dir); } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
}

// #444 AC1: a tracked ready-for-review PR whose latest review is CHANGES_REQUESTED
// gets exactly one rework even when the PR is conflicted and its label still reads
// state:in-review (the review-verdict flip was skipped) — the reactor keys off the
// rejection's id, never the label, so the stub offers no label survey at all.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 1 }) }); // no reviewedAt: a fresh rejection
  const spawns = [];
  const spawn = (argv, env, logFile) => { spawns.push({ argv, env, logFile }); return 4321; };
  const calls = [];
  const r = await reviewOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: mkGh({ prs: prsWith("CHANGES_REQUESTED"), reviews: reviewWith("R1"), calls }),
    isAlive: () => false, spawn, now: () => NOW, log: () => {},
  });
  assert.equal(spawns.length, 1, "a CHANGES_REQUESTED review dispatches exactly one rework");
  assert.ok(spawns[0].argv.includes("--resume"), "the rework runs on the existing branch via the adapter's resume command");
  assert.match(spawns[0].argv.join(" "), /#42/, "the prompt names the PR under review");
  const s = readState("s.json")["7"];
  assert.equal(s.attempts, 2, "the rework counts one attempt toward reworkCap");
  assert.equal(s.status, "reworking");
  assert.equal(s.pid, 4321);
  assert.equal(s.reviewedAt, "R1", "the dedup records the rejection's id, not the label");
  assert.equal(r.transitions.length, 1);
  // Read-only: only pr list + pr view (the detail read), never an issue-label survey or mutation.
  const subs = calls.map((c) => `${c[0]} ${c[1]}`);
  assert.deepEqual([...new Set(subs)].sort(), ["pr list", "pr view"], "the reactor only reads pr list + pr view — no label survey, no mutation");
});

// #444 AC2: after the rework worker pushes its fix, the same rejection is not
// re-dispatched — the dedup holds without the label flipping back to
// state:in-review. reviewDecision is still CHANGES_REQUESTED and the review id is
// unchanged, so an entry already marked reviewedAt=R1 stands down.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 2, reviewedAt: "R1" }) });
  const calls = [];
  const r = await reviewOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: mkGh({ prs: prsWith("CHANGES_REQUESTED"), reviews: reviewWith("R1"), calls }),
    isAlive: () => false, spawn: noSpawn("must not re-dispatch the same rejection after the worker pushed"),
    now: () => NOW, log: () => {},
  });
  assert.equal(r.transitions.length, 0, "the already-handled rejection dispatches nothing");
  assert.equal(readState("s.json")["7"].status, "ready-for-review", "the entry is left untouched");
  assert.ok(!existsSync("esc.md"), "no escalation on a still-outstanding, already-handled rejection");
});

// #444 AC3: a genuinely new Request Changes review after a rework dispatches one
// more rework up to reworkCap, then escalates exactly once at the cap. reworkCap 2:
// R1 dispatches the rework that reaches the cap; a new rejection R2 then escalates
// once and is not re-escalated.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 1 }) });
  const calls = [];
  let reviews = reviewWith("R1");
  const spawn = () => 5555;
  // Pass 1: R1 is fresh — dispatch the rework that lifts attempts to the cap.
  await reviewOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: mkGh({ prs: prsWith("CHANGES_REQUESTED"), reviews: () => reviews(), calls }),
    isAlive: () => false, spawn, now: () => NOW, log: () => {},
  });
  assert.equal(readState("s.json")["7"].attempts, 2, "the one available rework runs, reaching reworkCap");
  // The worker finished and re-verification returned the entry to ready-for-review.
  const mid = readState("s.json"); mid["7"].status = "ready-for-review"; mid["7"].pid = null; writeStateFile("s.json", mid);
  // Pass 2: a genuinely new rejection (R2) at the cap escalates exactly once.
  reviews = reviewWith("R2", "2026-07-11T00:00:00Z");
  const r2 = await reviewOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: mkGh({ prs: prsWith("CHANGES_REQUESTED"), reviews: () => reviews(), calls }),
    isAlive: () => false, spawn: noSpawn("at the cap the reactor escalates, never re-dispatches"),
    now: () => NOW, log: () => {},
  });
  assert.equal(r2.transitions[0].action, "escalate-review-capped", "a new rejection at the cap escalates");
  assert.equal(readState("s.json")["7"].status, "escalated");
  assert.equal(readState("s.json")["7"].reviewedAt, "R2", "the escalation is recorded against the new rejection's id");
  const esc = readFileSync("esc.md", "utf8");
  assert.match(esc, /#42/, "the escalation names the PR");
  assert.match(esc, /reworkCap 2/, "the escalation names reworkCap");
  // Pass 3: R2 unchanged — no second escalation for the same rejection.
  await reviewOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: mkGh({ prs: prsWith("CHANGES_REQUESTED"), reviews: () => reviews(), calls }),
    isAlive: () => false, spawn: noSpawn("the escalated entry is never revisited"),
    now: () => NOW, log: () => {},
  });
  assert.equal((readFileSync("esc.md", "utf8").match(/reworkCap 2 reached/g) || []).length, 1, "the cap escalates exactly once");
});

// #444 AC4: an APPROVED, COMMENTED, or absent review decision dispatches nothing,
// unchanged — and none even triggers the per-PR review-detail read.
for (const decision of ["APPROVED", "COMMENTED", null]) {
  await inTempDir(async () => {
    writeStateFile("s.json", { 7: entry({ attempts: 1 }) });
    const calls = [];
    const r = await reviewOnce({
      config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
      gh: mkGh({ prs: prsWith(decision), reviews: reviewWith("R1"), calls }),
      isAlive: () => false, spawn: noSpawn(`a ${decision} decision must not dispatch anything`),
      now: () => NOW, log: () => {},
    });
    assert.equal(r.transitions.length, 0, `${decision} dispatches nothing`);
    assert.equal(readState("s.json")["7"].status, "ready-for-review", `${decision} leaves the entry unchanged`);
    assert.ok(!calls.some((c) => c[0] === "pr" && c[1] === "view"), `${decision} skips the per-PR review-detail read`);
  });
}

// #444 AC5: every criterion above has exactly one test named after it — this file
// declares AC1–AC4 once each, no padding.
const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
for (const ac of ["AC1", "AC2", "AC3", "AC4"]) {
  const hits = (self.match(new RegExp(`#444 ${ac}:`, "g")) || []).length;
  assert.equal(hits, 1, `#444 ${ac} has exactly one test named after it`);
}

// #445 AC1: when herd dispatches a rework for a changes-requested PR that is also
// conflicting (mergeable CONFLICTING or merge-state DIRTY), the rework instruction
// directs the worker to merge origin/main and resolve every conflict in addition to
// addressing the review feedback, then push — leaving the PR mergeable, not dirty.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 1 }) });
  const spawns = [];
  const spawn = (argv, env, logFile) => { spawns.push({ argv, env, logFile }); return 4321; };
  const calls = [];
  await reviewOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: mkGh({ prs: prsMerge("CHANGES_REQUESTED", { mergeable: "CONFLICTING" }), reviews: reviewWith("R1"), calls }),
    isAlive: () => false, spawn, now: () => NOW, log: () => {},
  });
  assert.equal(spawns.length, 1, "a conflicting changes-requested PR dispatches exactly one rework");
  const argv = spawns[0].argv.join(" ");
  assert.match(argv, /merge origin\/main/, "the rework directs the worker to merge origin/main");
  assert.match(argv, /resolve every conflict/, "the rework directs the worker to resolve every conflict");
  assert.match(argv, /review feedback/, "the rework still directs the worker to address the review feedback");
  assert.match(argv, /mergeable, not dirty/, "the rework's goal is a mergeable, not dirty, PR");
  assert.match(argv, /#42/, "the prompt names the PR under review");
  const s = readState("s.json")["7"];
  assert.equal(s.attempts, 2, "the conflict rework counts one attempt toward reworkCap");
  assert.equal(s.status, "reworking");
});

// #445 AC2: when the same PR is not conflicting, the rework instruction is the
// review-only prompt, unchanged from today — no conflict-resolution wording.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 1 }) });
  const spawns = [];
  const spawn = (argv, env, logFile) => { spawns.push({ argv, env, logFile }); return 4321; };
  const calls = [];
  await reviewOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: mkGh({ prs: prsMerge("CHANGES_REQUESTED", { mergeable: "MERGEABLE" }), reviews: reviewWith("R1"), calls }),
    isAlive: () => false, spawn, now: () => NOW, log: () => {},
  });
  assert.equal(spawns.length, 1, "a clean changes-requested PR still dispatches one rework");
  const argv = spawns[0].argv.join(" ");
  const reviewOnly = REVIEW_REWORK_PROMPT.replaceAll("{pr}", "42").replaceAll("{issue}", "7");
  assert.ok(argv.includes(reviewOnly), "a non-conflicting PR gets the unchanged review-only prompt");
  assert.doesNotMatch(argv, /resolve every conflict/, "the review-only prompt carries no conflict-resolution wording");
});

// #445 AC3: the conflict-and-review rework counts against the same reworkCap as
// other reworks, and at the cap it escalates exactly once, naming that the PR is
// both conflicting and changes-requested. reworkCap 2: R1 dispatches the conflict
// rework that reaches the cap; a new rejection R2 (still conflicting) then escalates
// once, naming both conditions, and is not re-escalated.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 1 }) });
  const calls = [];
  let reviews = reviewWith("R1");
  const spawn = () => 5555;
  const conflicted = () => prsMerge("CHANGES_REQUESTED", { mergeStateStatus: "DIRTY" })();
  // Pass 1: a fresh conflicting rejection dispatches the rework that lifts attempts
  // to the cap — a conflict rework spends one attempt exactly like a review rework.
  await reviewOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: mkGh({ prs: conflicted, reviews: () => reviews(), calls }),
    isAlive: () => false, spawn, now: () => NOW, log: () => {},
  });
  assert.equal(readState("s.json")["7"].attempts, 2, "the conflict rework counts toward reworkCap, reaching it");
  const mid = readState("s.json"); mid["7"].status = "ready-for-review"; mid["7"].pid = null; writeStateFile("s.json", mid);
  // Pass 2: a genuinely new rejection (R2), still conflicting, at the cap escalates once.
  reviews = reviewWith("R2", "2026-07-11T00:00:00Z");
  const r2 = await reviewOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: mkGh({ prs: conflicted, reviews: () => reviews(), calls }),
    isAlive: () => false, spawn: noSpawn("at the cap the reactor escalates, never re-dispatches"),
    now: () => NOW, log: () => {},
  });
  assert.equal(r2.transitions[0].action, "escalate-review-capped", "a new conflicting rejection at the cap escalates");
  const esc = readFileSync("esc.md", "utf8");
  assert.match(esc, /Request Changes review and conflicts with main/, "the escalation names both conditions");
  assert.match(esc, /reworkCap 2/, "the escalation names reworkCap");
  // Pass 3: R2 unchanged — no second escalation for the same rejection.
  await reviewOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: mkGh({ prs: conflicted, reviews: () => reviews(), calls }),
    isAlive: () => false, spawn: noSpawn("the escalated entry is never revisited"),
    now: () => NOW, log: () => {},
  });
  assert.equal((readFileSync("esc.md", "utf8").match(/reworkCap 2 reached/g) || []).length, 1, "the conflict-and-review cap escalates exactly once");
});

// #445 AC4: every criterion above has exactly one test named after it — AC1–AC3
// once each, no padding.
for (const ac of ["AC1", "AC2", "AC3"]) {
  const hits = (self.match(new RegExp(`#445 ${ac}:`, "g")) || []).length;
  assert.equal(hits, 1, `#445 ${ac} has exactly one test named after it`);
}

// #446 AC1: the review-rework instruction directs the worker to read every review
// comment and classify each as an in-scope fix or out-of-scope/new-feature work
// before acting — a Request Changes review is not automatically an in-scope fix.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 1 }) });
  const spawns = [];
  const spawn = (argv, env, logFile) => { spawns.push({ argv, env, logFile }); return 4321; };
  const calls = [];
  await reviewOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: mkGh({ prs: prsMerge("CHANGES_REQUESTED", { mergeable: "MERGEABLE" }), reviews: reviewWith("R1"), calls }),
    isAlive: () => false, spawn, now: () => NOW, log: () => {},
  });
  assert.equal(spawns.length, 1, "a changes-requested PR dispatches exactly one rework");
  const argv = spawns[0].argv.join(" ");
  assert.match(argv, /classify each point/, "the rework directs the worker to classify each review point");
  assert.match(argv, /in-scope fix or out-of-scope/, "the classification names in-scope versus out-of-scope work");
  assert.match(argv, /before acting/, "the classification happens before the worker acts on any point");
});

// #446 AC2: for in-scope feedback the instruction directs the worker to address it
// with commits on the PR's existing branch — no new PR, no plan file — and, on a
// conflicting PR, alongside the 0185 conflict resolution so the fix and the conflict
// resolution land in the same PR.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 1 }) });
  const spawns = [];
  const spawn = (argv, env, logFile) => { spawns.push({ argv, env, logFile }); return 4321; };
  const calls = [];
  await reviewOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: mkGh({ prs: prsMerge("CHANGES_REQUESTED", { mergeable: "CONFLICTING" }), reviews: reviewWith("R1"), calls }),
    isAlive: () => false, spawn, now: () => NOW, log: () => {},
  });
  assert.equal(spawns.length, 1, "a conflicting changes-requested PR dispatches exactly one rework");
  const argv = spawns[0].argv.join(" ");
  assert.match(argv, /in-scope point with focused commits on this PR's existing branch/, "in-scope feedback is committed on the PR's existing branch");
  assert.match(argv, /alongside the conflict resolution/, "the in-scope fix lands alongside the 0185 conflict resolution");
  assert.match(argv, /land in the same PR/, "the fix and the conflict resolution share one PR");
  assert.match(argv, /no new PR, no plan file/, "in-scope feedback opens no new PR and files no plan");
});

// #446 AC3: for out-of-scope or new-feature feedback the instruction directs the
// worker NOT to implement it in this PR, but to file it through the ratchet-plan
// protocol (a plan file on the planning PR) and reply on the review pointing to that
// plan.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 1 }) });
  const spawns = [];
  const spawn = (argv, env, logFile) => { spawns.push({ argv, env, logFile }); return 4321; };
  const calls = [];
  await reviewOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: mkGh({ prs: prsMerge("CHANGES_REQUESTED", { mergeable: "MERGEABLE" }), reviews: reviewWith("R1"), calls }),
    isAlive: () => false, spawn, now: () => NOW, log: () => {},
  });
  const argv = spawns[0].argv.join(" ");
  assert.match(argv, /Do NOT implement any out-of-scope or new-feature point in this PR/, "out-of-scope feedback is not built into this PR");
  assert.match(argv, /file it through the ratchet-plan protocol \(a plan\/\*\.md on the planning PR\)/, "out-of-scope feedback is routed to a plan file on the planning PR");
  assert.match(argv, /reply to that review comment pointing to the plan/, "the worker replies on the review pointing to the plan");
});

// #446 AC4: every criterion above has exactly one test named after it — this file
// declares AC1–AC3 once each, no padding.
for (const ac of ["AC1", "AC2", "AC3"]) {
  const hits = (self.match(new RegExp(`#446 ${ac}:`, "g")) || []).length;
  assert.equal(hits, 1, `#446 ${ac} has exactly one test named after it`);
}

console.log("PASS herd-review.test.mjs");
