#!/usr/bin/env node
// herd-review.test.mjs — the criteria are the test plan. One test per acceptance
// criterion of issue #193 (the herd review-verdict reactor: a CHANGES_REQUESTED
// review on a tracked ready-for-review PR dispatches a rework), driven through
// herd-review.mjs's public interface. Offline: gh and spawn are injected, so no
// network and no real worker is launched, and every gh call is recorded to prove
// the reactor only reads (never merges/approves/closes/labels). Zero
// dependencies. Run:  node scripts/herd-review.test.mjs

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewOnce } from "./herd-review.mjs";
import { readState } from "./herd-survey.mjs";

const NOW = Date.UTC(2026, 6, 10, 12, 0, 0);
const noSpawn = (msg) => () => {
  throw new Error(msg);
};
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

// A gh stub: `pr list` returns the open-PR review decisions, `issue list` returns
// the issues labelled state:changes-requested. Every call is recorded so a test
// can prove the reactor mutates nothing on GitHub. `failList` makes the PR review
// survey throw (the transient-verdict-read case).
const mkGh = (openPrs, crIssues, calls, { failList = false } = {}) => async (args) => {
  calls.push(args);
  if (args[0] === "pr" && args[1] === "list") {
    if (failList) throw new Error("gh pr list boom");
    return openPrs;
  }
  if (args[0] === "issue" && args[1] === "list") return crIssues;
  throw new Error(`unexpected gh call: ${args.join(" ")}`);
};

// A ready-for-review entry: a worker opened PR #42 for issue #7 and exited; verify
// declared it ready. This is the exact terminal state a human then reviews.
const entry = (over = {}) => ({ adapter: "claude", pid: null, logFile: "logs/issue-7.log", attempts: 1, status: "ready-for-review", pr: 42, ...over });
const CR = (n = 7) => [{ number: n }]; // issues carrying state:changes-requested
const prs = (decision) => [{ number: 42, headRefName: "agent/issue-7", reviewDecision: decision }];

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-review-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    return await fn(dir);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

// #193 AC1: a CHANGES_REQUESTED review on a tracked ready-for-review PR dispatches
// exactly one rework worker on the issue's existing branch (the resume command),
// with a prompt directing it to the PR's review feedback; the attempt counts
// toward reworkCap.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 1 }) });
  const spawns = [];
  const spawn = (argv, env, logFile) => {
    spawns.push({ argv, env, logFile });
    return 4321;
  };
  const calls = [];
  const r = await reviewOnce({
    config: mkConfig(),
    statePath: "s.json",
    escalationsPath: "esc.md",
    gh: mkGh(prs("CHANGES_REQUESTED"), CR(7), calls),
    isAlive: () => false,
    spawn,
    now: () => NOW,
    log: () => {},
  });
  assert.equal(spawns.length, 1, "a CHANGES_REQUESTED review dispatches exactly one rework");
  const argv = spawns[0].argv;
  assert.ok(argv.includes("--resume"), "the rework runs on the existing branch via the adapter's resume command");
  const prompt = argv.join(" ");
  assert.match(prompt, /review feedback/i, "the prompt directs the worker to the PR's review feedback");
  assert.match(prompt, /#42/, "the prompt names the PR under review");
  assert.match(prompt, /existing PR/i, "the prompt keeps the same PR (no new PR opened)");
  const s = readState("s.json")["7"];
  assert.equal(s.attempts, 2, "the rework counts toward reworkCap (attempts bumped)");
  assert.equal(s.status, "reworking");
  assert.equal(s.pid, 4321);
  assert.equal(r.transitions.length, 1);
});

// #193 AC2: a rework at the cap is escalated instead of re-dispatched — the
// escalation names the PR and the reworkCap, and no worker is spawned.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 2 }) }); // reworkCap default is 2
  const calls = [];
  await reviewOnce({
    config: mkConfig(),
    statePath: "s.json",
    escalationsPath: "esc.md",
    gh: mkGh(prs("CHANGES_REQUESTED"), CR(7), calls),
    isAlive: () => false,
    spawn: noSpawn("must not dispatch a rework at the cap"),
    now: () => NOW,
    log: () => {},
  });
  const esc = readFileSync("esc.md", "utf8");
  assert.match(esc, /#42/, "the escalation names the PR");
  assert.match(esc, /reworkCap 2/, "the escalation names the reworkCap");
  assert.equal(readState("s.json")["7"].status, "escalated", "the capped entry is escalated");
});

// #193 AC3: after the rework worker pushes and flips the issue back to
// state:in-review, the reactor stands down — a lingering CHANGES_REQUESTED verdict
// whose issue no longer carries state:changes-requested dispatches nothing.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 1 }) });
  const calls = [];
  const r = await reviewOnce({
    config: mkConfig(),
    statePath: "s.json",
    escalationsPath: "esc.md",
    gh: mkGh(prs("CHANGES_REQUESTED"), [], calls), // issue #7 is no longer labelled changes-requested
    isAlive: () => false,
    spawn: noSpawn("must not re-dispatch once the issue is back to state:in-review"),
    now: () => NOW,
    log: () => {},
  });
  assert.equal(readState("s.json")["7"].status, "ready-for-review", "the entry is left untouched");
  assert.equal(r.transitions.length, 0, "no rework is dispatched for an already-reworked PR");
});

// #193 AC4: an APPROVED review dispatches nothing and changes no labels — merging
// stays human-only. The reactor only reads (pr list + issue list); it never
// mutates a label or the PR.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 1 }) });
  const calls = [];
  const r = await reviewOnce({
    config: mkConfig(),
    statePath: "s.json",
    escalationsPath: "esc.md",
    gh: mkGh(prs("APPROVED"), CR(7), calls),
    isAlive: () => false,
    spawn: noSpawn("an APPROVED review must not dispatch anything"),
    now: () => NOW,
    log: () => {},
  });
  assert.equal(r.transitions.length, 0, "APPROVED dispatches nothing");
  assert.equal(readState("s.json")["7"].status, "ready-for-review", "APPROVED leaves the entry unchanged");
  for (const c of calls) assert.ok(c[1] === "list", `the reactor only reads GitHub, never mutates it (saw: ${c.join(" ")})`);
});

// #193 AC5: a CHANGES_REQUESTED PR already being reworked — a live worker on the
// entry — is not dispatched again on subsequent polls.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 2, status: "reworking", pid: 9999 }) });
  const calls = [];
  const r = await reviewOnce({
    config: mkConfig(),
    statePath: "s.json",
    escalationsPath: "esc.md",
    gh: mkGh(prs("CHANGES_REQUESTED"), CR(7), calls),
    isAlive: (pid) => pid === 9999, // the rework worker is still alive
    spawn: noSpawn("must not dispatch while a rework worker is live"),
    now: () => NOW,
    log: () => {},
  });
  assert.equal(r.transitions.length, 0, "a live rework worker is never dispatched twice");
  assert.equal(readState("s.json")["7"].status, "reworking", "the in-flight rework entry is left untouched");
});

// #193 AC6: a transient failure reading the review decision leaves every entry
// untouched and is retried next poll — a blip never misreads a verdict.
await inTempDir(async () => {
  writeStateFile("s.json", { 7: entry({ attempts: 1 }) });
  const calls = [];
  const r = await reviewOnce({
    config: mkConfig(),
    statePath: "s.json",
    escalationsPath: "esc.md",
    gh: mkGh(prs("CHANGES_REQUESTED"), CR(7), calls, { failList: true }),
    isAlive: () => false,
    spawn: noSpawn("a transient review-read failure must not dispatch"),
    now: () => NOW,
    log: () => {},
  });
  assert.equal(r.ok, false, "the pass reports the transient failure");
  assert.equal(readState("s.json")["7"].status, "ready-for-review", "the entry is untouched after a failed read");
  assert.ok(!existsSync("esc.md"), "no escalation is written on a transient read failure");
});

// #193 AC7: every criterion above has exactly one test named after it — this file
// declares AC1–AC6 once each, no padding.
{
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (const ac of ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6"]) {
    const hits = (self.match(new RegExp(`#193 ${ac}:`, "g")) || []).length;
    assert.equal(hits, 1, `#193 ${ac} has exactly one test named after it`);
  }
}

console.log("PASS herd-review.test.mjs");
