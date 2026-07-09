#!/usr/bin/env node
// herd-survey.test.mjs — the criteria are the test plan. One test per
// acceptance criterion of issue #104 (herd state file, survey/reconcile loop,
// escalation writer), exercised through herd-survey.mjs's public interface.
// Fully offline: gh, process liveness, the clock, and the sleep are all
// injected, so nothing spawns a process or hits the network.
// Zero dependencies. Run:  node scripts/herd-survey.test.mjs

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  surveyReality,
  reconcileState,
  readState,
  formatEscalation,
  appendEscalation,
  pollOnce,
  pruneLogs,
  runLoop,
} from "./herd-survey.mjs";
import { dispatchOne } from "./herd-dispatch.mjs";

const NOW = Date.UTC(2026, 6, 9, 12, 0, 0); // fixed clock — no Date.now dependence

// Minimal supervisor config for the dispatch-side integration check below.
const mkConfig = () => ({
  maxWorkers: 3,
  pollSeconds: 60,
  logDir: "logs",
  adapters: { claude: { launch: ["claude", "-p", "{prompt}"], promptTemplate: "issue {issue}", env: {} } },
  routing: { default: "claude", labels: {} },
});

// A fake `gh` that routes by the survey's own argument shape and records calls.
function fakeGh({ ready = [], inProgress = [], openPrs = [] } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === "pr") return openPrs;
    if (args.includes("state:ready")) return ready;
    if (args.includes("state:in-progress")) return inProgress;
    return [];
  };
  gh.calls = calls;
  return gh;
}

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-survey-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    return await fn(dir);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Criterion 1: each poll surveys gh for state:ready issues, state:in-progress
// issues, and open PRs.
{
  const gh = fakeGh({
    ready: [{ number: 1 }],
    inProgress: [{ number: 2 }],
    openPrs: [{ number: 5, headRefName: "agent/issue-2" }],
  });
  const r = await surveyReality(gh);
  assert.deepEqual(r.ready, [{ number: 1 }], "returns the ready queue");
  assert.deepEqual(r.inProgress, [{ number: 2 }], "returns in-progress issues");
  assert.equal(r.openPrs.length, 1, "returns open PRs");
  assert.ok(gh.calls.some((a) => a.includes("state:ready")), "surveyed state:ready");
  assert.ok(gh.calls.some((a) => a.includes("state:in-progress")), "surveyed state:in-progress");
  assert.ok(gh.calls.some((a) => a[0] === "pr"), "surveyed open PRs");
}

// Criterion 2: on startup, state-file entries with dead pids or merged PRs are
// reconciled against reality instead of trusted; a live, still-open worker is
// left alone.
{
  const state = {
    10: { adapter: "claude", pid: 999999, logFile: "a.log", pr: null, status: "working" },
    11: { adapter: "codex", pid: null, logFile: "b.log", pr: 42, status: "in-review" },
    12: { adapter: "claude", pid: 1234, logFile: "c.log", pr: 7, status: "working" },
  };
  const isAlive = (pid) => pid === 1234;
  const { state: next, changes } = reconcileState(state, { openPrNumbers: new Set([7]) }, isAlive);
  assert.equal(next[10].status, "dead", "a dead pid is reconciled, not trusted");
  assert.equal(next[10].pid, null, "the dead pid is cleared");
  assert.equal(next[11].status, "pr-concluded", "a PR no longer open (merged) is reconciled");
  assert.equal(next[12].status, "working", "a live worker with an open PR is left alone");
  assert.equal(next[12].pid, 1234, "the live pid is preserved");
  assert.equal(changes.length, 2, "both anomalies are flagged, the healthy entry is not");
}

// Criterion 3: a missing or corrupt state file is rebuilt from gh and liveness
// checks, never a crash.
await inTempDir(async () => {
  assert.deepEqual(readState("missing.json"), {}, "a missing state file reads as {}");
  writeFileSync("corrupt.json", "{ not json");
  assert.deepEqual(readState("corrupt.json"), {}, "a corrupt state file reads as {} (no crash)");

  writeFileSync("s.json", "{ broken");
  const gh = fakeGh({ ready: [{ number: 1 }] });
  const r = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  assert.equal(r.ok, true, "a poll over a corrupt state file completes");
  const rebuilt = JSON.parse(readFileSync("s.json", "utf8"));
  assert.ok(rebuilt && typeof rebuilt === "object" && !Array.isArray(rebuilt), "the state file is rebuilt as valid JSON");
});

// Criterion 4: a failed gh call logs one clear line and retries on the next
// poll instead of crashing the supervisor.
await inTempDir(async () => {
  const logs = [];
  const gh = async () => {
    throw new Error("gh: not authenticated");
  };
  const r = await pollOnce({ gh, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: (m) => logs.push(m) });
  assert.equal(r.ok, false, "a gh failure does not crash the poll");
  assert.equal(logs.length, 1, "exactly one line is logged");
  assert.match(logs[0], /gh survey failed[\s\S]*retry/i, "the line names the failure and that it retries next poll");
});

// Criterion 5: escalations append human-readable entries with timestamp, issue,
// what happened, log file path, and suggested action.
{
  const block = formatEscalation({
    now: NOW,
    issue: "42",
    what: "worker pid 5 is not alive",
    logFile: ".ratchet/logs/42.log",
    action: "re-queue the issue",
  });
  assert.match(block, /2026-07-09T12:00:00\.000Z/, "carries an ISO timestamp");
  assert.match(block, /#42/, "names the issue");
  assert.match(block, /worker pid 5 is not alive/, "says what happened");
  assert.match(block, /\.ratchet\/logs\/42\.log/, "names the log file path");
  assert.match(block, /Suggested action: re-queue the issue/, "gives a suggested action");
}
await inTempDir(async () => {
  appendEscalation("e.md", { now: NOW, issue: "1", what: "x", logFile: "a.log" });
  appendEscalation("e.md", { now: NOW, issue: "2", what: "y", logFile: "b.log" });
  const text = readFileSync("e.md", "utf8");
  assert.equal((text.match(/^## /gm) || []).length, 2, "escalations append, never overwrite");
});

// Criterion 6: --once performs a single pass and exits; default keeps polling
// every pollSeconds.
await inTempDir(async () => {
  const ghOnce = fakeGh({ ready: [{ number: 1 }] });
  let slept = 0;
  await runLoop({
    gh: ghOnce, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md",
    log: () => {}, once: true, sleep: () => (slept++, Promise.resolve()),
  });
  assert.equal(ghOnce.calls.filter((a) => a[0] === "pr").length, 1, "--once performs exactly one pass");
  assert.equal(slept, 0, "--once never sleeps");

  const ghLoop = fakeGh({ ready: [{ number: 1 }] });
  let sleeps = 0;
  const sleep = () => {
    if (++sleeps >= 2) throw new Error("STOP");
    return Promise.resolve();
  };
  await assert.rejects(
    runLoop({ gh: ghLoop, isAlive: () => false, now: NOW, statePath: "s2.json", escalationsPath: "e2.md", log: () => {}, once: false, sleep }),
    /STOP/,
  );
  assert.equal(ghLoop.calls.filter((a) => a[0] === "pr").length, 2, "the default keeps polling past the first pass");
});

// Criterion 7: with no ready issues and no live workers, the supervisor prints
// a /ratchet-status-style diagnosis pointer.
await inTempDir(async () => {
  const logs = [];
  const gh = fakeGh({ ready: [], inProgress: [], openPrs: [] });
  const r = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: (m) => logs.push(m) });
  assert.equal(r.idle, true, "no ready issues and no live workers reads as idle");
  assert.ok(logs.some((m) => /ratchet-status/.test(m)), "prints a /ratchet-status diagnosis pointer");
});

// --- Issue #137: prune concluded herd state entries so a re-queued issue can
// dispatch again. One test per acceptance criterion, named after it. ---

// #137 criterion 1: an entry whose tracked PR is merged or closed is removed
// from the state file after its reconciliation escalation is written.
await inTempDir(async () => {
  writeFileSync(
    "s.json",
    JSON.stringify({ 20: { adapter: "claude", pid: null, logFile: "x.log", pr: 99, status: "in-review" } }),
  );
  const gh = fakeGh({ ready: [], inProgress: [], openPrs: [] }); // PR 99 is not open
  const r = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  const esc = readFileSync("e.md", "utf8");
  assert.match(esc, /#20/, "the reconciliation escalation is written for the concluded entry");
  const after = JSON.parse(readFileSync("s.json", "utf8"));
  assert.equal(after[20], undefined, "the entry whose PR concluded is removed from the state file");
  assert.equal(r.pruned, 1, "the removal is counted");
});

// #137 criterion 2: an issue whose worker died, whose entry was reconciled
// away, and which returns to state:ready is dispatched again on a later poll
// instead of being skipped.
await inTempDir(async () => {
  writeFileSync(
    "s.json",
    JSON.stringify({ 30: { adapter: "claude", pid: 999999, logFile: "y.log", pr: null, status: "working" } }),
  );
  const gh = fakeGh({ ready: [{ number: 30 }], inProgress: [], openPrs: [] });
  const ready = [{ number: 30, createdAt: "2026-01-01", labels: [{ name: "priority:high" }] }];
  const disp = () =>
    dispatchOne({
      config: mkConfig(), ready, statePath: "s.json", escalationsPath: "e.md",
      gh, isAlive: () => false, now: () => NOW, dryRun: true, log: () => {},
    });

  const before = await disp();
  assert.equal(before.reason, "no-eligible-issue", "while the stale entry sits in state, dispatch skips the re-queued issue");

  await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });

  const after = await disp();
  assert.equal(after.plan?.issue, 30, "after the dead entry is pruned, the re-queued issue dispatches instead of being skipped");
});

// #137 criterion 3: an entry with a live worker pid or an open PR is never
// removed.
await inTempDir(async () => {
  writeFileSync(
    "s.json",
    JSON.stringify({
      40: { adapter: "claude", pid: 1234, logFile: "a.log", pr: null, status: "working" },
      41: { adapter: "codex", pid: null, logFile: "b.log", pr: 7, status: "in-review" },
    }),
  );
  const gh = fakeGh({ ready: [], inProgress: [], openPrs: [{ number: 7, headRefName: "agent/issue-41" }] });
  const r = await pollOnce({ gh, isAlive: (pid) => pid === 1234, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  const after = JSON.parse(readFileSync("s.json", "utf8"));
  assert.ok(after[40], "an entry with a live worker pid is retained");
  assert.ok(after[41], "an entry tracking an open PR is retained");
  assert.equal(r.pruned, 0, "nothing is pruned when every entry is live or open");
});

// #137 criterion 4: the poll summary line reports how many entries were pruned
// this pass.
await inTempDir(async () => {
  const logs = [];
  writeFileSync(
    "s.json",
    JSON.stringify({ 50: { adapter: "claude", pid: 999999, logFile: "z.log", pr: null, status: "working" } }),
  );
  const gh = fakeGh({ ready: [], inProgress: [], openPrs: [] });
  await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /1 concluded entry pruned/.test(m)), "the poll summary line reports the pruned count");
});

// --- Issue #138: detect and escalate stale agent/issue-N claim branches that
// block re-work. One test per acceptance criterion, named after it. AC2 (the
// dispatch-timeout re-check) lives in herd-dispatch.test.mjs. ---

// A `gh` that also answers the stale-claim ref list (matching-refs) with the
// given claim-ref issue numbers, on top of the survey's ready/in-progress/PR.
function fakeGhWithRefs({ ready = [], inProgress = [], openPrs = [], claimRefs = [], refsThrow = false } = {}) {
  return async (args) => {
    if (args[0] === "api" && String(args[1]).includes("matching-refs")) {
      if (refsThrow) throw new Error("transient network blip");
      return claimRefs.map((n) => ({ ref: `refs/heads/agent/issue-${n}` }));
    }
    if (args[0] === "pr") return openPrs;
    if (args.includes("state:ready")) return ready;
    if (args.includes("state:in-progress")) return inProgress;
    return [];
  };
}

// #138 AC1) A claim ref agent/issue-<N> on origin whose issue has no live worker
// in the state file and no open PR is escalated as a stale claim, naming the ref
// and the exact command that deletes it.
await inTempDir(async () => {
  const gh = fakeGhWithRefs({ claimRefs: [77] }); // ref present, no worker, no PR
  const r = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  assert.equal(r.staleEscalated, 1, "the stale claim ref is escalated");
  const esc = readFileSync("e.md", "utf8");
  assert.match(esc, /stale claim ref agent\/issue-77 on origin/, "the escalation names the stale ref");
  assert.match(
    esc,
    /gh api -X DELETE repos\/\{owner\}\/\{repo\}\/git\/refs\/heads\/agent\/issue-77/,
    "the escalation includes the exact delete command",
  );
});

// #138 AC3) A ref with a live worker or an open PR is never flagged: a live-pid
// state entry (issue 40) and an open-PR-backed ref (issue 41) both pass.
await inTempDir(async () => {
  writeFileSync(
    "s.json",
    JSON.stringify({ 40: { adapter: "claude", pid: 1234, logFile: "a.log", pr: null, status: "working" } }),
  );
  const gh = fakeGhWithRefs({ claimRefs: [40, 41], openPrs: [{ number: 7, headRefName: "agent/issue-41" }] });
  const r = await pollOnce({ gh, isAlive: (pid) => pid === 1234, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  assert.equal(r.staleEscalated, 0, "neither a live-worker ref nor an open-PR ref is flagged");
  assert.ok(!existsSync("e.md"), "no stale-claim escalation is written for backed refs");
});

// #138 AC4) A transient gh failure while checking refs never produces a
// stale-claim escalation on its own — the poll still completes and logs a skip.
await inTempDir(async () => {
  const logs = [];
  const gh = fakeGhWithRefs({ refsThrow: true }); // survey succeeds, ref list fails
  const r = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: (m) => logs.push(m) });
  assert.equal(r.ok, true, "the poll completes despite the ref-list failure");
  assert.equal(r.staleEscalated, 0, "a transient ref-list failure escalates nothing");
  assert.ok(!existsSync("e.md"), "no stale-claim escalation is written on a transient blip");
  assert.ok(logs.some((m) => /stale-claim ref check failed/.test(m)), "logs that stale detection was skipped this poll");
});

// #138 AC5) Each stale ref is escalated once, not re-escalated every poll: two
// consecutive polls over the same stale ref append exactly one escalation.
await inTempDir(async () => {
  const gh = fakeGhWithRefs({ claimRefs: [88] });
  const opts = { gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} };
  const r1 = await pollOnce(opts);
  const r2 = await pollOnce(opts);
  assert.equal(r1.staleEscalated, 1, "escalated on the poll that first saw it");
  assert.equal(r2.staleEscalated, 0, "not re-escalated on the next poll");
  const esc = readFileSync("e.md", "utf8");
  assert.equal((esc.match(/^## /gm) || []).length, 1, "exactly one escalation block despite two polls");
});

// #138 AC6) Every criterion above has exactly one test named after it — AC1–AC5
// each appear exactly once across this file and herd-dispatch.test.mjs (AC2).
{
  const survey = readFileSync(new URL("./herd-survey.test.mjs", import.meta.url), "utf8");
  const dispatch = readFileSync(new URL("./herd-dispatch.test.mjs", import.meta.url), "utf8");
  const both = survey + dispatch;
  for (const ac of ["AC1", "AC2", "AC3", "AC4", "AC5"]) {
    const hits = (both.match(new RegExp(`#138 ${ac}\\)`, "g")) || []).length;
    assert.equal(hits, 1, `#138 ${ac} has exactly one test named after it`);
  }
}

// --- Issue #139: bound worker log growth with a retention knob. One test per
// acceptance criterion, named after it. ---

// Criterion 8 (#139 AC2): a log file older than the retention window whose
// issue has no live worker in the state file is deleted during the poll.
await inTempDir(async () => {
  const logDir = ".ratchet/logs";
  mkdirSync(logDir, { recursive: true });
  const stale = join(logDir, "issue-1.log");
  writeFileSync(stale, "output from a worker that is long gone");
  const twentyDaysAgo = (NOW - 20 * 86400 * 1000) / 1000; // seconds, for utimes
  utimesSync(stale, twentyDaysAgo, twentyDaysAgo);

  // A dead worker still on record: reconcile clears its pid, so it is not live.
  writeFileSync("s.json", JSON.stringify({ 1: { adapter: "claude", pid: 999999, logFile: stale, status: "working" } }));
  const gh = fakeGh({ ready: [], inProgress: [], openPrs: [] });
  const r = await pollOnce({
    gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md",
    log: () => {}, config: { logDir, logRetentionDays: 14 },
  });
  assert.equal(existsSync(stale), false, "the stale log of an issue with no live worker is deleted during the poll");
  assert.equal(r.prunedLogs, 1, "the poll reports the one pruned log");
});

// Criterion 9 (#139 AC3): a log referenced by a live worker's state entry is
// never deleted, regardless of age.
await inTempDir(async () => {
  const logDir = ".ratchet/logs";
  mkdirSync(logDir, { recursive: true });
  const liveLog = join(logDir, "issue-2.log");
  writeFileSync(liveLog, "output from a worker that is still running");
  const ancient = (NOW - 999 * 86400 * 1000) / 1000; // far past any retention window
  utimesSync(liveLog, ancient, ancient);

  const state = { 2: { adapter: "claude", pid: 4242, logFile: liveLog, status: "working" } };
  const pruned = pruneLogs({ logDir, retentionDays: 14, state, isAlive: (pid) => pid === 4242, now: NOW });
  assert.equal(pruned, 0, "an ancient log owned by a live worker is not pruned");
  assert.equal(existsSync(liveLog), true, "the live worker's log survives regardless of its age");
});

// Criterion 10 (#139 AC4): the poll summary line reports how many log files
// were pruned this pass.
await inTempDir(async () => {
  const logDir = ".ratchet/logs";
  mkdirSync(logDir, { recursive: true });
  for (const n of [1, 2]) {
    const f = join(logDir, `issue-${n}.log`);
    writeFileSync(f, "stale");
    const old = (NOW - 30 * 86400 * 1000) / 1000;
    utimesSync(f, old, old);
  }
  const logs = [];
  const gh = fakeGh({ ready: [], inProgress: [], openPrs: [] });
  const r = await pollOnce({
    gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md",
    log: (m) => logs.push(m), config: { logDir, logRetentionDays: 14 },
  });
  assert.equal(r.prunedLogs, 2, "both stale logs are pruned this pass");
  const summary = logs.find((m) => /log file\(s\) pruned/.test(m));
  assert.ok(summary, "a poll summary line is printed");
  assert.match(summary, /2 log file\(s\) pruned/, "the summary line reports the number pruned this pass");
});

console.log("PASS herd-survey.test.mjs (7 criteria + issue #137: 4 criteria + issue #138: 5 criteria + issue #139: 3 criteria)");
