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
import { reviewOnce } from "./herd-review.mjs";
import { readState } from "./herd-survey.mjs";

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

console.log("PASS herd-review.test.mjs");
