#!/usr/bin/env node
// herd-survey.test.mjs — the criteria are the test plan. One test per
// acceptance criterion of issue #104 (herd state file, survey/reconcile loop,
// escalation writer), exercised through herd-survey.mjs's public interface.
// Fully offline: gh, process liveness, the clock, and the sleep are all
// injected, so nothing spawns a process or hits the network.
// Zero dependencies. Run:  node scripts/herd-survey.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  surveyReality,
  reconcileState,
  readState,
  formatEscalation,
  appendEscalation,
  appendHerdEvent,
  HERD_EVENT_TYPES,
  pollOnce,
  pruneLogs,
  runLoop,
  surveyTargets,
  classifyTargets,
  markScopedComplete,
  scopedRun,
  SCOPED_NO_ELIGIBLE_EXIT,
  createSupervisorPump,
} from "./herd-survey.mjs";
import { dispatchOne, recordExit, supervisorStep } from "./herd-dispatch.mjs";
import { monitorOnce } from "./herd-monitor.mjs";
import { verifyOnce } from "./herd-verify.mjs";
import { normalizeConfig } from "./herd.mjs";

const NOW = Date.UTC(2026, 6, 9, 12, 0, 0); // fixed clock — no Date.now dependence
const MIN = 60 * 1000; // one minute in ms, for advancing the fixed clock between polls

// Minimal supervisor config for the dispatch-side integration check below.
const mkConfig = () => ({
 maxWorkers: 3,
 pollSeconds: 60,
 reworkCap: 2,
 logDir: "logs",
 adapters: { claude: { launch: ["claude", "-p", "{prompt}"], resume: ["claude", "--resume", "{issue}", "{prompt}"], promptTemplate: "issue {issue}", env: {} } },
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

// A fake conditional `gh` caller for the ETag survey. `plan` maps each endpoint
// key (ready / inProgress / openPrs) to a sequence of { status, etag, body }
// responses consumed one per call (the last one repeats). It records the
// (path, etag) of every call so a test can assert the If-None-Match it sent.
function fakeGhc(plan = {}) {
  const calls = [];
  const idx = {};
  const ghc = async (path, etag) => {
    calls.push({ path, etag });
    const key = path.includes("pulls")
      ? "openPrs"
      : path.includes("state:in-progress")
        ? "inProgress"
        : "ready";
    const seq = plan[key] || [{ status: 200, etag: null, body: [] }];
    const i = idx[key] ?? 0;
    idx[key] = i + 1;
    return seq[Math.min(i, seq.length - 1)];
  };
  ghc.calls = calls;
  return ghc;
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

const readEvents = (path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

async function produceEventFixture(eventsPath, logs = []) {
  await dispatchOne({
    config: mkConfig(), ready: [{ number: 60, createdAt: "2026-01-01", labels: [] }],
    statePath: "d.json", escalationsPath: "d.md", eventsPath, spawn: () => 600,
    gh: async () => ({ ref: "refs/heads/agent/issue-60" }), isAlive: () => false,
    now: () => NOW, sleep: async () => {}, log: (m) => logs.push(m), claimTimeoutMs: 1000,
  });
  let t = NOW;
  await dispatchOne({
    config: mkConfig(), ready: [{ number: 61, createdAt: "2026-01-02", labels: [] }],
    statePath: "k.json", escalationsPath: "k.md", eventsPath, spawn: () => 601,
    gh: async () => { throw new Error("404 Not Found"); }, isAlive: () => false, kill: () => {},
    now: () => t, sleep: (ms) => ((t += ms), Promise.resolve()), log: (m) => logs.push(m),
    claimTimeoutMs: 1000, claimIntervalMs: 1000,
  });
  writeFileSync("x.json", JSON.stringify({ 62: { adapter: "claude", pid: 602, logFile: "logs/issue-62.log", attempts: 1, status: "dispatched", pr: null } }));
  recordExit("x.json", 62, 0, null, { eventsPath, now: () => NOW, warn: (m) => logs.push(m) });
  writeFileSync("p.json", JSON.stringify({ 63: { adapter: "claude", pid: null, logFile: "logs/issue-63.log", attempts: 1, status: "dispatched", pr: null, exitCode: 0 } }));
  await monitorOnce({
    config: mkConfig(), statePath: "p.json", escalationsPath: "p.md", eventsPath,
    gh: async () => [{ number: 63, headRefName: "agent/issue-63" }], isAlive: () => false,
    spawn: () => { throw new Error("must not spawn on PR detection"); }, now: () => NOW, log: (m) => logs.push(m),
  });
  writeFileSync("r.json", JSON.stringify({ 64: { adapter: "claude", pid: 604, logFile: "logs/issue-64.log", attempts: 1, status: "dispatched", pr: null, exitCode: 1 } }));
  await monitorOnce({
    config: mkConfig(), statePath: "r.json", escalationsPath: "r.md", eventsPath,
    gh: async () => [], isAlive: () => false, spawn: () => 6040, now: () => NOW, log: (m) => logs.push(m),
  });
  writeFileSync("w.json", JSON.stringify({ 65: { adapter: "claude", pid: null, logFile: "logs/issue-65.log", attempts: 1, status: "awaiting-verification", pr: 65 } }));
  await verifyOnce({
    config: mkConfig(), statePath: "w.json", escalationsPath: "w.md", eventsPath,
    gh: async () => ({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", body: "Closes #65\n\n## Gates" }),
    spawn: () => 6050, now: () => NOW, log: (m) => logs.push(m),
  });
}

// #143 AC1: every supervisor lifecycle transition appends one documented JSON line with ts, event, and issue.
await inTempDir(async () => {
  await produceEventFixture("events.jsonl");
  const events = readEvents("events.jsonl");
  for (const event of ["dispatch", "resume", "rework", "claim-detected", "pr-detected", "worker-exit", "worker-kill", "escalation"])
    assert.ok(events.some((e) => e.event === event), `event stream includes ${event}`);
  for (const event of events) {
    assert.ok(!Number.isNaN(Date.parse(event.ts)), "event timestamp is ISO-like");
    assert.ok(HERD_EVENT_TYPES.includes(event.event), `event type is documented: ${event.event}`);
    assert.equal(typeof event.issue, "number", "event carries issue number");
  }
});

// #143 AC2: worker-scoped events carry adapter, pid, log file, and attempt count.
await inTempDir(async () => {
  await produceEventFixture("events.jsonl");
  for (const event of readEvents("events.jsonl").filter((e) => e.adapter)) {
    assert.equal(event.adapter, "claude", `${event.event} carries adapter`);
    assert.ok(Object.hasOwn(event, "pid"), `${event.event} carries pid`);
    assert.match(event.logFile, /logs\/issue-\d+\.log/, `${event.event} carries log file`);
    assert.equal(typeof event.attempts, "number", `${event.event} carries attempts`);
  }
});

// #143 AC3: event stream is append-only across supervisor restarts.
await inTempDir(async () => {
  const first = { ts: new Date(NOW).toISOString(), event: "dispatch", issue: 70 };
  writeFileSync("events.jsonl", JSON.stringify(first) + "\n");
  appendHerdEvent("events.jsonl", { now: NOW + 1, event: "claim-detected", issue: 70 }, () => {});
  const events = readEvents("events.jsonl");
  assert.deepEqual(events[0], first, "existing line is preserved");
  assert.equal(events.length, 2, "new line is appended");
});

// #143 AC4: a failed event write prints one warning naming the file and poll continues.
await inTempDir(async () => {
  mkdirSync("events-dir");
  writeFileSync("s.json", JSON.stringify({ 71: { adapter: "claude", pid: 701, logFile: "logs/issue-71.log", attempts: 1, status: "dispatched", pr: null } }));
  const logs = [];
  const r = await pollOnce({
    gh: fakeGh({ ready: [], inProgress: [], openPrs: [] }), isAlive: () => false, now: NOW,
    statePath: "s.json", escalationsPath: "e.md", eventsPath: "events-dir", log: (m) => logs.push(m),
  });
  const warnings = logs.filter((m) => /failed to append event/.test(m));
  assert.equal(r.ok, true, "poll completes despite event write failure");
  assert.equal(warnings.length, 1, "one warning is printed");
  assert.match(warnings[0], /events-dir/, "warning names the event path");
  assert.ok(existsSync("e.md"), "escalation still completes");
});

// #143 AC5: every criterion above has exactly one test named after it.
{
  const self = readFileSync(new URL("./herd-survey.test.mjs", import.meta.url), "utf8");
  for (const ac of ["AC1", "AC2", "AC3", "AC4", "AC5"]) {
    const hits = (self.match(new RegExp(`// #143 ${ac}:`, "g")) || []).length;
    assert.equal(hits, 1, `#143 ${ac} exactly one test named after it`);
  }
}

// --- Issue #138: detect and escalate stale agent/issue-N claim branches that
// block re-work. One test per acceptance criterion, named after it. AC2 (the
// dispatch-timeout re-check) lives in herd-dispatch.test.mjs. ---

// A `gh` that also answers the stale-claim ref list (matching-refs) with the
// given claim-ref issue numbers, on top of the survey's ready/in-progress/PR.
function fakeGhWithRefs({ ready = [], inProgress = [], openPrs = [], claimRefs = [], refsThrow = false, closedIssues = [], issueStateThrow = false } = {}) {
  return async (args) => {
    if (args[0] === "api" && String(args[1]).includes("matching-refs")) {
      if (refsThrow) throw new Error("transient network blip");
      return claimRefs.map((n) => ({ ref: `refs/heads/agent/issue-${n}` }));
    }
    if (args[0] === "issue" && args[1] === "view") {
      if (issueStateThrow) throw new Error("transient gh blip");
      const n = Number(args[2]);
      return { state: closedIssues.includes(n) ? "CLOSED" : "OPEN" };
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

// --- Issue #173: stale-claim detection distinguishes closed issues from blocked
// open ones. One test per acceptance criterion, named after it. ---

// #173 AC1) A stale ref whose issue is closed is escalated with a message saying
// the issue is closed and only the ref needs deleting — no re-queue instruction.
await inTempDir(async () => {
  const gh = fakeGhWithRefs({ claimRefs: [77], closedIssues: [77] });
  const r = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  assert.equal(r.staleEscalated, 1, "the closed-issue stale ref is escalated");
  const esc = readFileSync("e.md", "utf8");
  assert.match(esc, /issue is closed/, "the escalation says the issue is closed");
  assert.match(esc, /pure garbage/, "the escalation calls it pure garbage");
  assert.doesNotMatch(esc, /re-queue the issue/, "no re-queue instruction for a closed issue");
  assert.match(esc, /gh api -X DELETE.*agent\/issue-77/, "the escalation includes the delete command");
});

// #173 AC2) A stale ref whose issue is closed records a suppression sentinel,
// not a live worker row: the entry carries the stale-claim status with pid null
// (issue #441 — the sentinel is what makes the ref escalate exactly once).
await inTempDir(async () => {
  const gh = fakeGhWithRefs({ claimRefs: [77], closedIssues: [77] });
  await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  const state = JSON.parse(readFileSync("s.json", "utf8"));
  assert.equal(state["77"]?.status, "stale-claim", "a stale-claim sentinel, not a worker row, is recorded for a closed-issue stale ref");
  assert.equal(state["77"].pid, null, "the sentinel tracks no live worker");
});

// #173 AC3) A stale ref whose issue is still open keeps the existing escalation
// wording, including the re-queue instruction.
await inTempDir(async () => {
  const gh = fakeGhWithRefs({ claimRefs: [88] }); // issue 88 is open (default)
  const r = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  assert.equal(r.staleEscalated, 1, "the open-issue stale ref is escalated");
  const esc = readFileSync("e.md", "utf8");
  assert.match(esc, /every future worker 422s and refuses the issue/, "keeps the existing open-issue wording");
  assert.match(esc, /re-queue the issue if its work is unfinished/, "keeps the re-queue instruction");
});

// #173 AC4) A transient failure while checking issue state never changes the
// escalation outcome on its own; the check is retried on the next poll.
await inTempDir(async () => {
  const logs = [];
  const gh = fakeGhWithRefs({ claimRefs: [77], issueStateThrow: true });
  const r = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: (m) => logs.push(m) });
  assert.equal(r.ok, true, "the poll completes despite the issue-state check failure");
  assert.equal(r.staleEscalated, 0, "no escalation on a transient issue-state failure");
  assert.ok(!existsSync("e.md"), "no escalation written on a transient blip");
  assert.ok(logs.some((m) => /issue-state check failed.*#77/.test(m)), "logs that the issue-state check was skipped for #77");
  const state = JSON.parse(readFileSync("s.json", "utf8"));
  assert.ok(!("77" in state), "no worker row created on a transient failure");

  // On the next poll the check succeeds (issue is open) and the escalation fires.
  const gh2 = fakeGhWithRefs({ claimRefs: [77] });
  const r2 = await pollOnce({ gh: gh2, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  assert.equal(r2.staleEscalated, 1, "the check is retried on the next poll and the escalation fires");
});

// #173 AC5) Every criterion above has exactly one test named after it.
{
  const self = readFileSync(new URL("./herd-survey.test.mjs", import.meta.url), "utf8");
  for (const ac of ["AC1", "AC2", "AC3", "AC4"]) {
    const hits = (self.match(new RegExp(`#173 ${ac}\\)`, "g")) || []).length;
    assert.equal(hits, 1, `#173 ${ac} has exactly one test named after it`);
  }
}

// --- Issue #441: a stale claim ref on a closed issue is escalated once, not
// every poll. One test per acceptance criterion, named after it. ---

// #441 AC1) A stale ref whose issue is closed is escalated exactly once: a later
// poll with the ref still present writes no escalation entry, bumps no
// occurrence count, and makes no issue-state API call for it.
await inTempDir(async () => {
  const calls = [];
  const inner = fakeGhWithRefs({ claimRefs: [77], closedIssues: [77] });
  const gh = async (a) => { calls.push(a); return inner(a); };

  const r1 = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  assert.equal(r1.staleEscalated, 1, "the closed-issue stale ref is escalated on the first poll");
  const afterFirst = readFileSync("e.md", "utf8");

  calls.length = 0;
  const r2 = await pollOnce({ gh, isAlive: () => false, now: NOW + MIN, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  assert.equal(r2.staleEscalated, 0, "a later poll does not re-escalate the same closed-issue ref");
  assert.equal(readFileSync("e.md", "utf8"), afterFirst, "no escalation entry is written and no occurrence count is bumped on the later poll");
  assert.ok(!calls.some((a) => a[0] === "issue" && a[1] === "view"), "no issue-state API call is made for the already-escalated closed ref");
});

// #441 AC2) The per-poll summary counts only stale refs newly escalated this
// pass: a ref escalated on an earlier poll no longer appears in the count, even
// as a brand-new stale ref is escalated alongside it.
await inTempDir(async () => {
  const gh1 = fakeGhWithRefs({ claimRefs: [77], closedIssues: [77] });
  const r1 = await pollOnce({ gh: gh1, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  assert.equal(r1.staleEscalated, 1, "the first closed ref is counted on its first poll");

  // Next poll: #77 still lingers (already escalated), #78 is newly stale.
  const gh2 = fakeGhWithRefs({ claimRefs: [77, 78], closedIssues: [77, 78] });
  const r2 = await pollOnce({ gh: gh2, isAlive: () => false, now: NOW + MIN, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  assert.equal(r2.staleEscalated, 1, "the summary counts only the newly escalated ref, not the one escalated on an earlier poll");
});

// #441 AC3) Once the stale ref is deleted from origin its suppression is
// cleared, so a genuine recurrence of the same ref escalates again.
await inTempDir(async () => {
  const escd = fakeGhWithRefs({ claimRefs: [77], closedIssues: [77] });
  const r1 = await pollOnce({ gh: escd, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  assert.equal(r1.staleEscalated, 1, "the closed ref is escalated when it first appears");

  // The ref is deleted from origin: the sentinel is cleared this poll.
  const gone = fakeGhWithRefs({ claimRefs: [], closedIssues: [77] });
  await pollOnce({ gh: gone, isAlive: () => false, now: NOW + MIN, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  const cleared = JSON.parse(readFileSync("s.json", "utf8"));
  assert.ok(!("77" in cleared), "the suppression sentinel is cleared once the ref is gone");

  // The same ref reappears: with suppression cleared, it escalates again.
  const back = fakeGhWithRefs({ claimRefs: [77], closedIssues: [77] });
  const r3 = await pollOnce({ gh: back, isAlive: () => false, now: NOW + 2 * MIN, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  assert.equal(r3.staleEscalated, 1, "a genuine recurrence of the same ref escalates again");
});

// #441 AC4) Every criterion above has exactly one test named after it.
{
  const self = readFileSync(new URL("./herd-survey.test.mjs", import.meta.url), "utf8");
  for (const ac of ["AC1", "AC2", "AC3"]) {
    const hits = (self.match(new RegExp(`#441 ${ac}\\)`, "g")) || []).length;
    assert.equal(hits, 1, `#441 ${ac} has exactly one test named after it`);
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

// A raw config whose one adapter declares a usage mapping — each field a regex
// whose first capture group is the number the core extracts from the log.
const usageRaw = {
  adapters: {
    claude: {
      launch: ["claude", "-p", "{prompt}"],
      usage: { costUsd: "cost=\\$([0-9.]+)", tokensIn: "in=(\\d+)", tokensOut: "out=(\\d+)" },
    },
  },
  routing: { default: "claude" },
};

// Criterion (#163 AC2): when an adapter declares usage, the worker-exit event in
// the event stream carries the extracted costUsd, tokensIn, and tokensOut.
await inTempDir(async () => {
  const config = normalizeConfig(usageRaw);
  mkdirSync("logs", { recursive: true });
  writeFileSync("logs/issue-70.log", "starting\ncost=$1.23\nin=4096 out=888\ndone\n");
  writeFileSync("s.json", JSON.stringify({ 70: { adapter: "claude", pid: 700, logFile: "logs/issue-70.log", attempts: 1, status: "dispatched", pr: null } }));
  const warns = [];
  recordExit("s.json", 70, 0, null, { config, eventsPath: "events.jsonl", now: () => NOW, warn: (m) => warns.push(m) });
  const exit = readEvents("events.jsonl").find((e) => e.event === "worker-exit" && e.issue === 70);
  assert.ok(exit, "a worker-exit event was written");
  assert.equal(exit.costUsd, 1.23, "costUsd is extracted from the worker's log");
  assert.equal(exit.tokensIn, 4096, "tokensIn is extracted from the worker's log");
  assert.equal(exit.tokensOut, 888, "tokensOut is extracted from the worker's log");
  assert.deepEqual(warns.filter((m) => /usage field/.test(m)), [], "a fully-read usage log warns about nothing");
});

// Criterion (#163 AC3): an adapter that declares no usage mapping dispatches and
// exits exactly as before — its worker-exit event omits the usage fields.
await inTempDir(async () => {
  const config = normalizeConfig({ adapters: { claude: { launch: ["claude", "-p", "{prompt}"] } }, routing: { default: "claude" } });
  assert.ok(!("usage" in config.adapters.claude), "a mapping-free adapter carries no usage field (unchanged shape)");
  mkdirSync("logs", { recursive: true });
  writeFileSync("logs/issue-71.log", "cost=$9.99 in=1 out=2\n"); // present but never consulted
  writeFileSync("s.json", JSON.stringify({ 71: { adapter: "claude", pid: 701, logFile: "logs/issue-71.log", attempts: 1, status: "dispatched", pr: null } }));
  recordExit("s.json", 71, 0, null, { config, eventsPath: "events.jsonl", now: () => NOW, warn: () => {} });
  const exit = readEvents("events.jsonl").find((e) => e.event === "worker-exit" && e.issue === 71);
  assert.ok(exit, "the worker-exit event is still written");
  for (const field of ["costUsd", "tokensIn", "tokensOut"])
    assert.ok(!(field in exit), `no usage mapping -> the event omits ${field}`);
  assert.equal(exit.adapter, "claude", "the pre-existing worker-exit fields are unchanged");
});

// Criterion (#163 AC5): a log lacking the declared usage values (adapter
// crashed, truncated output, or the file is gone) records the usage fields as
// null and logs one one-line warning; recordExit never throws, so the poll continues.
await inTempDir(async () => {
  const config = normalizeConfig(usageRaw);
  mkdirSync("logs", { recursive: true });
  // Case A: the log exists but the numbers the mapping expects are absent.
  writeFileSync("logs/issue-72.log", "worker started, then crashed before reporting usage\n");
  writeFileSync("s.json", JSON.stringify({ 72: { adapter: "claude", pid: 720, logFile: "logs/issue-72.log", attempts: 1, status: "dispatched", pr: null } }));
  const warnsA = [];
  assert.doesNotThrow(() => recordExit("s.json", 72, 0, null, { config, eventsPath: "events.jsonl", now: () => NOW, warn: (m) => warnsA.push(m) }));
  const exitA = readEvents("events.jsonl").find((e) => e.event === "worker-exit" && e.issue === 72);
  assert.equal(exitA.costUsd, null, "an unreadable value is recorded as null (costUsd)");
  assert.equal(exitA.tokensIn, null, "an unreadable value is recorded as null (tokensIn)");
  assert.equal(exitA.tokensOut, null, "an unreadable value is recorded as null (tokensOut)");
  const usageWarnsA = warnsA.filter((m) => /usage field/.test(m));
  assert.equal(usageWarnsA.length, 1, "exactly one usage warning is logged");
  assert.ok(!usageWarnsA[0].includes("\n"), "the warning is a single line");

  // Case B: the log file is gone entirely — still nulls + a warning, no throw.
  writeFileSync("s2.json", JSON.stringify({ 73: { adapter: "claude", pid: 730, logFile: "logs/does-not-exist.log", attempts: 1, status: "dispatched", pr: null } }));
  const warnsB = [];
  assert.doesNotThrow(() => recordExit("s2.json", 73, 0, null, { config, eventsPath: "events2.jsonl", now: () => NOW, warn: (m) => warnsB.push(m) }));
  const exitB = readEvents("events2.jsonl").find((e) => e.event === "worker-exit" && e.issue === 73);
  assert.equal(exitB.costUsd, null, "a missing log file records null, not a crash");
  assert.ok(warnsB.some((m) => /usage field/.test(m)), "the missing-log case still warns on one line");
});

// --- Issue #169: stop the survey/monitor ping-pong that re-escalates stale
// claims every poll. AC1 (the monitor never classifies a stale-claim sentinel)
// lives in herd-monitor.test.mjs; the survey/interaction criteria are here. ---

// #169 AC2) A stale claim ref produces exactly one escalation across any number
// of subsequent polls while the ref, the sentinel, and the herd state are
// otherwise unchanged: alternating survey and monitor polls over the same stale
// ref — the exact ping-pong — append exactly one escalation block, not a wall.
await inTempDir(async () => {
  const gh = fakeGhWithRefs({ claimRefs: [175] }); // ref present, no worker, no PR
  const survey = { gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} };
  const monitor = {
    config: mkConfig(), statePath: "s.json", escalationsPath: "e.md", eventsPath: "ev.jsonl", gh,
    isAlive: () => false, spawn: () => { throw new Error("the monitor must not resume a stale sentinel"); },
    now: () => NOW, log: () => {},
  };
  const s1 = await pollOnce(survey);
  await monitorOnce(monitor);
  const s2 = await pollOnce(survey);
  await monitorOnce(monitor);
  const s3 = await pollOnce(survey);
  assert.equal(s1.staleEscalated, 1, "escalated once on the poll that first saw the stale ref");
  assert.equal(s2.staleEscalated, 0, "not re-escalated after a monitor pass");
  assert.equal(s3.staleEscalated, 0, "still not re-escalated on any later poll");
  const esc = readFileSync("e.md", "utf8");
  assert.equal((esc.match(/^## /gm) || []).length, 1, "exactly one escalation block across five interleaved polls");
});

// #169 AC3) When the stale ref disappears from origin, the sentinel entry is
// removed from the state file on the next poll — a resolved claim leaves no
// orphaned bookkeeping behind.
await inTempDir(async () => {
  const opts = { isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} };
  await pollOnce({ ...opts, gh: fakeGhWithRefs({ claimRefs: [175] }) });
  assert.equal(readState("s.json")["175"]?.status, "stale-claim", "the first poll records the sentinel");
  await pollOnce({ ...opts, gh: fakeGhWithRefs({ claimRefs: [] }) }); // the human deleted the ref
  assert.equal("175" in readState("s.json"), false, "the sentinel entry is removed once the ref is gone");
});

// #169 AC4) A supervisor restart mid-loop does not re-escalate a stale ref whose
// sentinel entry already exists in the state file: a fresh poll that reads the
// persisted sentinel re-recognises it and escalates nothing.
await inTempDir(async () => {
  // State persisted before the restart: the ref was already escalated once.
  writeFileSync("s.json", JSON.stringify({ 175: { adapter: null, pid: null, logFile: null, attempts: 0, status: "stale-claim", pr: null } }));
  const gh = fakeGhWithRefs({ claimRefs: [175] }); // the ref is still there after the restart
  const r = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  assert.equal(r.staleEscalated, 0, "the persisted sentinel is not re-escalated after a restart");
  assert.equal(existsSync("e.md"), false, "no new escalation block is written on restart");
});

// #169 AC5) Every criterion above has exactly one test named after it — AC1
// (the monitor side) lives in herd-monitor.test.mjs, AC2–AC4 here; each appears
// exactly once across the two files.
{
  const survey = readFileSync(new URL("./herd-survey.test.mjs", import.meta.url), "utf8");
  const monitor = readFileSync(new URL("./herd-monitor.test.mjs", import.meta.url), "utf8");
  const both = survey + monitor;
  for (const ac of ["AC1", "AC2", "AC3", "AC4"]) {
    const hits = (both.match(new RegExp(`#169 ${ac}\\)`, "g")) || []).length;
    assert.equal(hits, 1, `#169 ${ac} has exactly one test named after it`);
  }
}

// --- Issue #170: prune terminal herd state entries that carry no pid and no
// open PR. reconcileState only flags dead pids / concluded PRs, so a terminal
// entry (dispatch-failed, escalated, verify-escalated) with pid:null/pr:null is
// never flagged and the #137 change-driven prune never touches it — it lingers
// and dispatch skips its issue forever. One test per acceptance criterion. ---

// #170 criterion 1: a terminal-status entry with no live pid and no open PR is
// removed from the state file after its escalation has been written. The
// escalation was written by dispatch when the entry entered dispatch-failed; the
// prune does not re-write it (pre-seeded here, asserted still present and not
// duplicated), it only removes the lingering entry.
await inTempDir(async () => {
  writeFileSync(
    "s.json",
    JSON.stringify({ 83: { adapter: "claude", pid: null, logFile: "x.log", attempts: 1, pr: null, status: "dispatch-failed" } }),
  );
  writeFileSync("e.md", "## earlier — issue #83\n- What happened: dispatch failed\n\n"); // escalation already written by dispatch
  const gh = fakeGh({ ready: [], inProgress: [], openPrs: [] });
  const r = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  const after = JSON.parse(readFileSync("s.json", "utf8"));
  assert.equal(after[83], undefined, "the terminal entry with no pid and no open PR is removed");
  const esc = readFileSync("e.md", "utf8");
  assert.equal((esc.match(/issue #83/g) || []).length, 1, "its escalation is present and not re-written on prune");
  assert.equal(r.terminalPruned, 1, "the terminal removal is counted");
});

// #170 criterion 2: an issue whose terminal entry was pruned and which is still
// state:ready is dispatched again on a later poll instead of being skipped.
await inTempDir(async () => {
  writeFileSync(
    "s.json",
    JSON.stringify({ 122: { adapter: "claude", pid: null, logFile: "y.log", attempts: 1, pr: null, status: "dispatch-failed" } }),
  );
  const gh = fakeGh({ ready: [], inProgress: [], openPrs: [] });
  const ready = [{ number: 122, createdAt: "2026-01-01", labels: [{ name: "priority:high" }] }];
  const disp = () =>
    dispatchOne({
      config: mkConfig(), ready, statePath: "s.json", escalationsPath: "e.md",
      gh, isAlive: () => false, now: () => NOW, dryRun: true, log: () => {},
    });

  const before = await disp();
  assert.equal(before.reason, "no-eligible-issue", "while the terminal entry sits in state, dispatch skips the re-queued issue");

  await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });

  const after = await disp();
  assert.equal(after.plan?.issue, 122, "after the terminal entry is pruned, the still-ready issue dispatches instead of being skipped");
});

// #170 criterion 3: an entry with a live worker pid or an open PR is never
// pruned regardless of status — including terminal statuses.
await inTempDir(async () => {
  writeFileSync(
    "s.json",
    JSON.stringify({
      160: { adapter: "claude", pid: null, logFile: "a.log", attempts: 1, pr: 8, status: "ready-for-review" },
      166: { adapter: "codex", pid: 1234, logFile: "b.log", attempts: 1, pr: null, status: "escalated" },
    }),
  );
  const gh = fakeGh({ ready: [], inProgress: [], openPrs: [{ number: 8, headRefName: "agent/issue-160" }] });
  const r = await pollOnce({ gh, isAlive: (pid) => pid === 1234, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  const after = JSON.parse(readFileSync("s.json", "utf8"));
  assert.ok(after[160], "a terminal entry tracking an open PR is retained");
  assert.ok(after[166], "a terminal entry with a live worker pid is retained");
  assert.equal(r.terminalPruned, 0, "nothing is pruned when a terminal entry is still live or open");
});

// #170 criterion 4: the poll summary line reports how many terminal entries were
// pruned this pass.
await inTempDir(async () => {
  const logs = [];
  writeFileSync(
    "s.json",
    JSON.stringify({ 168: { adapter: "claude", pid: null, logFile: "z.log", attempts: 1, pr: null, status: "dispatch-failed" } }),
  );
  const gh = fakeGh({ ready: [], inProgress: [], openPrs: [] });
  await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /1 terminal entry pruned/.test(m)), "the poll summary line reports the terminal-pruned count");
});

// ── issue #357: herd scoped-run eligibility reporting & lifecycle ──
// A gh double answering `issue view --json number,state,labels` from a map of
// number -> { state, labels } ("error"/absent simulates an unreadable issue).
function fakeIssueGh(map) {
  return async (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      const n = Number(args[2]);
      const v = map[n];
      if (v === "error" || v === undefined) throw new Error(`no such issue #${n}`);
      return { number: n, state: v.state, labels: (v.labels || []).map((name) => ({ name })) };
    }
    return [];
  };
}
const noSleep = async () => {};

// Criterion 1: a requested issue that is closed, state:blocked, not state:ready,
// or already present in the state file is reported with a per-issue reason and
// an escalation entry, and is never spawned. The lone eligible target (#50) is
// the only issue ever handed to dispatch.
await inTempDir(async () => {
  writeFileSync(
    "s.json",
    JSON.stringify({ 40: { adapter: "claude", pid: null, logFile: null, attempts: 1, pr: null, status: "working" } }),
  );
  const gh = fakeIssueGh({
    10: { state: "CLOSED", labels: [] },
    20: { state: "OPEN", labels: ["state:blocked"] },
    30: { state: "OPEN", labels: ["state:draft"] },
    40: { state: "OPEN", labels: ["state:ready"] }, // ready, but already tracked
    50: { state: "OPEN", labels: ["state:ready"] }, // the one eligible target
  });
  const seenTargets = [];
  const step = async (o) => {
    seenTargets.push([...o.targets]);
    // Advance the eligible target to a scoped-done status so the loop exits.
    const st = readState("s.json");
    st["50"] = { adapter: "claude", pid: null, logFile: "x.log", attempts: 1, pr: 7, status: "ready-for-review" };
    writeFileSync("s.json", JSON.stringify(st));
  };
  const r = await scopedRun({
    gh, targets: [10, 20, 30, 40, 50], statePath: "s.json", escalationsPath: "e.md",
    eventsPath: "ev.jsonl", log: () => {}, step, sleep: noSleep, now: () => NOW,
  });
  const esc = readFileSync("e.md", "utf8");
  assert.match(esc, /issue #10\n- What happened: [^\n]*\(closed\)/, "closed target #10 is escalated with its reason");
  assert.match(esc, /issue #20\n- What happened: [^\n]*\(blocked\)/, "state:blocked target #20 is escalated with its reason");
  assert.match(esc, /issue #30\n- What happened: [^\n]*\(not-ready\)/, "not-ready target #30 is escalated with its reason");
  assert.match(esc, /issue #40\n- What happened: [^\n]*\(already-tracked\)/, "already-tracked target #40 is escalated with its reason");
  assert.ok(seenTargets.length >= 1, "the loop ran on the eligible set");
  assert.ok(
    seenTargets.every((t) => t.length === 1 && t[0] === 50),
    "only the eligible target #50 is ever dispatched; no ineligible issue is spawned",
  );
  assert.equal(r.exitCode, 0, "the run completes 0 once the eligible target finishes");
});

// Criterion 2: when every requested issue is ineligible, the supervisor exits
// non-zero with the per-issue reasons and zero workers are spawned.
await inTempDir(async () => {
  const gh = fakeIssueGh({ 11: { state: "CLOSED", labels: [] }, 22: { state: "OPEN", labels: ["state:blocked"] } });
  let stepCalls = 0;
  const step = async () => { stepCalls += 1; };
  const r = await scopedRun({
    gh, targets: [11, 22], statePath: "s.json", escalationsPath: "e.md",
    eventsPath: "ev.jsonl", log: () => {}, step, sleep: noSleep, now: () => NOW,
  });
  assert.equal(r.exitCode, SCOPED_NO_ELIGIBLE_EXIT, "an all-ineligible scoped run exits with SCOPED_NO_ELIGIBLE_EXIT");
  assert.notEqual(r.exitCode, 0, "the exit code is non-zero");
  assert.equal(stepCalls, 0, "zero workers spawned — step never runs when nothing is eligible");
  assert.equal(r.spawned, 0, "the result records zero spawned workers");
  const esc = readFileSync("e.md", "utf8");
  assert.match(esc, /issue #11\n- What happened: [^\n]*\(closed\)/, "the closed target's reason is reported");
  assert.match(esc, /issue #22\n- What happened: [^\n]*\(blocked\)/, "the blocked target's reason is reported");
});

// Criterion 3: a scoped run exits once every eligible target has reached a
// terminal status in the state file, rather than polling forever. A bounded step
// advances one target per pass; the injected sleep throws past a pass budget, so
// termination is by completion, not luck.
await inTempDir(async () => {
  const gh = fakeIssueGh({ 1: { state: "OPEN", labels: ["state:ready"] }, 2: { state: "OPEN", labels: ["state:ready"] } });
  let pass = 0;
  const step = async () => {
    pass += 1;
    const st = readState("s.json");
    if (pass === 1) st["1"] = { adapter: "claude", pid: null, logFile: "a.log", attempts: 1, pr: null, status: "escalated" };
    if (pass === 2) st["2"] = { adapter: "claude", pid: null, logFile: "b.log", attempts: 1, pr: 9, status: "ready-for-review" };
    writeFileSync("s.json", JSON.stringify(st));
  };
  let slept = 0;
  const r = await scopedRun({
    gh, targets: [1, 2], statePath: "s.json", escalationsPath: "e.md", eventsPath: "ev.jsonl", log: () => {}, step,
    sleep: async () => { slept += 1; if (slept > 20) throw new Error("scoped run polled forever"); }, now: () => NOW,
  });
  assert.equal(r.exitCode, 0, "the scoped run exits 0 once every target is terminal");
  assert.equal(pass, 2, "it stops the pass after the last target reaches a terminal status");
  assert.deepEqual([...r.completed].sort((a, b) => a - b), [1, 2], "both targets are recorded finished");
});

// Test note: a target issue closing mid-run is treated as terminal, reported,
// and the scoped run exits once the remaining targets finish. #5 closes after
// the first pass; #6 finishes on the second.
await inTempDir(async () => {
  const issues = { 5: { state: "OPEN", labels: ["state:ready"] }, 6: { state: "OPEN", labels: ["state:ready"] } };
  const gh = async (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      const n = Number(args[2]);
      return { number: n, state: issues[n].state, labels: issues[n].labels.map((name) => ({ name })) };
    }
    return [];
  };
  let pass = 0;
  const logs = [];
  const step = async () => {
    pass += 1;
    if (pass === 1) issues[5].state = "CLOSED"; // #5 closes mid-run (merged or closed by a human)
    if (pass === 2) {
      const st = readState("s.json");
      st["6"] = { adapter: "claude", pid: null, logFile: "c.log", attempts: 1, pr: 3, status: "ready-for-review" };
      writeFileSync("s.json", JSON.stringify(st));
    }
  };
  const r = await scopedRun({
    gh, targets: [5, 6], statePath: "s.json", escalationsPath: "e.md", eventsPath: "ev.jsonl",
    log: (m) => logs.push(m), step, sleep: noSleep, now: () => NOW,
  });
  assert.equal(r.exitCode, 0, "the scoped run exits 0");
  assert.deepEqual([...r.completed].sort((a, b) => a - b), [5, 6], "the closed target #5 counts as finished alongside #6");
  assert.equal(pass, 2, "the run keeps polling until the remaining target #6 finishes, then exits");
  assert.ok(logs.some((m) => /scoped target #5 finished \(issue closed\)/.test(m)), "the mid-run close of #5 is reported");
});

// issue #405 criterion 1: reconcileState with a dead pid, entry.pr == null, and
// an open PR whose head is the claim branch agent/issue-<N> adopts the entry:
// status becomes awaiting-verification, pr is set to that PR, and no dead change
// or escalation is produced for it.
{
  const state = { 405: { adapter: "claude", pid: 999999, logFile: "a.log", pr: null, status: "working", attempts: 1 } };
  const prByHead = new Map([["agent/issue-405", 88]]);
  const { state: next, changes, adopted } = reconcileState(
    state,
    { openPrNumbers: new Set([88]), prByHead },
    () => false,
  );
  assert.equal(next[405].status, "awaiting-verification", "the dead worker's entry is adopted into verification");
  assert.equal(next[405].pr, 88, "the entry's pr is set to the open PR on its claim branch");
  assert.equal(next[405].pid, null, "the dead pid is cleared");
  assert.equal(changes.length, 0, "no dead change (and thus no escalation) is produced for an adopted entry");
  assert.equal(adopted.length, 1, "the adoption is reported");
  assert.deepEqual({ issue: adopted[0].issue, pr: adopted[0].pr }, { issue: "405", pr: 88 }, "the adoption names the issue and PR");
}

// issue #405 criterion 2: an adopted entry survives both of pollOnce's prune
// passes and is routed into the existing verify stage.
await inTempDir(async () => {
  writeFileSync(
    "s.json",
    JSON.stringify({ 405: { adapter: "claude", pid: 999999, logFile: "a.log", pr: null, status: "working", attempts: 1 } }),
  );
  const gh = fakeGh({ ready: [], inProgress: [], openPrs: [{ number: 88, headRefName: "agent/issue-405" }] });
  const r = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", eventsPath: "ev.jsonl", log: () => {} });
  assert.equal(r.pruned, 0, "the change-driven prune leaves the adopted entry");
  assert.equal(r.terminalPruned, 0, "the terminal-entry prune leaves the adopted entry (its PR is open)");
  const after = JSON.parse(readFileSync("s.json", "utf8"));
  assert.equal(after[405]?.status, "awaiting-verification", "the adopted entry survives both prune passes with the verify-stage status");
  assert.equal(after[405]?.pr, 88, "the adopted entry still tracks its open PR after the poll");
  // The verify stage consumes exactly this status/pr pair — feed the survived
  // state to verifyOnce and confirm it acts on the entry rather than skipping it.
  const verify = await verifyOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "v.md", eventsPath: "ev.jsonl",
    gh: async () => ({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", body: "Closes #405\n\n## Gates" }),
    spawn: () => 6050, now: () => NOW, log: () => {},
  });
  assert.ok(verify.transitions?.some((t) => Number(t.issue) === 405), "the adopted entry is routed into the verify stage");
});

// issue #405 criterion 3: pollOnce logs exactly one pr-detected event per
// adoption and reports the adoption count in its result.
await inTempDir(async () => {
  writeFileSync(
    "s.json",
    JSON.stringify({ 405: { adapter: "claude", pid: 999999, logFile: "a.log", pr: null, status: "working", attempts: 1 } }),
  );
  const gh = fakeGh({ ready: [], inProgress: [], openPrs: [{ number: 88, headRefName: "agent/issue-405" }] });
  const r = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", eventsPath: "ev.jsonl", log: () => {} });
  assert.equal(r.adopted, 1, "the result reports the adoption count");
  const detected = readEvents("ev.jsonl").filter((ev) => ev.event === "pr-detected");
  assert.equal(detected.length, 1, "exactly one pr-detected event is logged for the adoption");
  assert.equal(Number(detected[0].issue), 405, "the pr-detected event names the adopted issue");
  assert.equal(detected[0].pr, 88, "the pr-detected event names the adopted PR");
});

// issue #405 criterion 4: a dead pid with no open PR on its claim branch behaves
// exactly as before — flagged dead, escalated, pruned.
await inTempDir(async () => {
  writeFileSync(
    "s.json",
    JSON.stringify({ 405: { adapter: "claude", pid: 999999, logFile: "a.log", pr: null, status: "working", attempts: 1 } }),
  );
  const gh = fakeGh({ ready: [], inProgress: [], openPrs: [{ number: 88, headRefName: "agent/issue-999" }] });
  const r = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", eventsPath: "ev.jsonl", log: () => {} });
  assert.equal(r.adopted, 0, "no adoption when no open PR matches the claim branch");
  assert.equal(r.pruned, 1, "the dead entry is pruned as before");
  const after = JSON.parse(readFileSync("s.json", "utf8"));
  assert.equal(after[405], undefined, "the dead entry is removed from the state file");
  assert.match(readFileSync("e.md", "utf8"), /worker pid 999999 is not alive/, "the dead worker is escalated as before");
});

// issue #405 criterion 5: reconcileState called without the open-PR-by-head-
// branch input keeps its current behavior (legacy callers unaffected).
{
  const state = { 405: { adapter: "claude", pid: 999999, logFile: "a.log", pr: null, status: "working", attempts: 1 } };
  const { state: next, changes, adopted } = reconcileState(state, { openPrNumbers: new Set([88]) }, () => false);
  assert.equal(next[405].status, "dead", "with no prByHead a dead pid is flagged dead, not adopted");
  assert.equal(next[405].pid, null, "the dead pid is cleared, as before");
  assert.equal(changes.length, 1, "the dead entry is flagged for escalation, as before");
  assert.equal(adopted.length, 0, "no adoption happens without the open-PR-by-head-branch input");
}

// ── issue #419 (plan 0173): event-driven local dispatch. One test per
// acceptance criterion, named after it. ──

// #419 criterion 4: claim-window serialization holds — an exit or claim event
// arriving while another dispatch's claim window is open never starts a second
// concurrent claim window.
await inTempDir(async () => {
  let active = 0, maxActive = 0, n = 0, release;
  const order = [];
  const gate = new Promise((r) => { release = r; });
  const pump = createSupervisorPump({
    runPass: async (kind) => {
      active += 1; maxActive = Math.max(maxActive, active); order.push(kind);
      if (n++ === 0) await gate; // the first pass holds its "claim window" open
      active -= 1;
    },
  });
  const p1 = pump.tick(); // opens the claim window and blocks on the gate
  pump.event(); pump.event(); // two events arrive mid-window; both coalesce
  assert.equal(active, 1, "while a pass's claim window is open, no second pass runs beside it");
  release();
  await p1; await pump.idle();
  assert.equal(maxActive, 1, "at most one claim window is ever open at a time");
  assert.deepEqual(order, ["tick", "event"], "coalesced events run once, after the in-flight pass, never concurrently");
});

// #419 criterion 5: the periodic tick still runs and heartbeats are written at
// the pollSeconds cadence; event-driven passes neither add nor suppress them.
await inTempDir(async () => {
  let heartbeats = 0;
  const pass = (kind) =>
    supervisorStep({
      kind, gh: async () => [], config: mkConfig(), maxWorkers: 3,
      statePath: "s.json", escalationsPath: "e.md", eventsPath: "ev.jsonl",
      pollOnce: async () => { heartbeats += 1; },
      monitorOnce: async () => {},
      surveyReady: async () => [],
      dispatchOne: async () => ({ dispatched: null, reason: "no-eligible-issue" }),
      log: () => {},
    });
  await pass("tick");
  await pass("event");
  await pass("event");
  await pass("tick");
  assert.equal(heartbeats, 2, "one heartbeat per tick; the two event passes neither added nor suppressed a heartbeat");
});

// #419 criterion 6: a scoped run exits once every target reaches a terminal
// state, including when the final transition is observed via a local event
// rather than a tick.
await inTempDir(async () => {
  const gh = fakeIssueGh({ 1: { state: "OPEN", labels: ["state:ready"] }, 2: { state: "OPEN", labels: ["state:ready"] } });
  let ticks = 0, events = 0, trigger;
  const done = (pr) => ({ adapter: "claude", pid: null, logFile: "x.log", attempts: 1, pr, status: "ready-for-review" });
  const step = async (o) => {
    const st = readState("s.json");
    if (o.kind === "event") { events += 1; st["2"] = done(9); } // final transition via a local event
    else { ticks += 1; st["1"] = done(8); }
    writeFileSync("s.json", JSON.stringify(st));
  };
  const r = await scopedRun({
    gh, targets: [1, 2], statePath: "s.json", escalationsPath: "e.md", eventsPath: "ev.jsonl",
    log: () => {}, step, now: () => NOW,
    onExitSignal: (fn) => { trigger = fn; },
    // A worker exits between the first tick and the next: deliver it during the
    // metronome sleep so the completing pass is the local event, not a later tick.
    sleep: async () => { if (events === 0) await trigger(); },
  });
  assert.equal(r.exitCode, 0, "the scoped run exits 0 once every target is terminal");
  assert.equal(ticks, 1, "only the initial tick ran — the completing pass was a local event, not a later tick");
  assert.ok(events >= 1, "the final target transition was observed via a local worker-exit event");
  assert.deepEqual([...r.completed].sort((a, b) => a - b), [1, 2], "both targets are recorded finished");
});

// #419 criterion 7: an error thrown inside an event-triggered pass is logged as
// a herd event and does not crash the supervisor; the next tick reconciles.
await inTempDir(async () => {
  let ticks = 0, trigger, sleeps = 0;
  const step = async (o) => { if (o.kind === "event") throw new Error("reactive boom"); ticks += 1; };
  await assert.rejects(
    runLoop({
      gh: fakeGh({ ready: [] }), statePath: "s.json", escalationsPath: "e.md", eventsPath: "ev.jsonl",
      log: () => {}, step, now: () => NOW,
      onExitSignal: (fn) => { trigger = fn; },
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) await trigger(); // fire the failing event pass mid-run
        if (sleeps >= 3) throw new Error("STOP"); // bound the otherwise-infinite loop
      },
    }),
    /STOP/,
  );
  assert.match(readFileSync("ev.jsonl", "utf8"), /supervisor-pass-error/, "the event-pass error is logged as a herd event");
  assert.ok(ticks >= 2, "the supervisor survived the event error and kept ticking — the next tick reconciled");
});

// --- Issue #420: the survey sends conditional GitHub requests (ETag /
// If-None-Match) so an unchanged tick returns 304 and costs no rate limit.
// One test per acceptance criterion, named after it. ---

const pollArgs = (over) => ({
  gh: fakeGh(),
  isAlive: () => false,
  now: NOW,
  statePath: "s.json",
  escalationsPath: "e.md",
  eventsPath: "ev.jsonl",
  log: () => {},
  ...over,
});

// #420 AC1: the first request per endpoint is unconditional and stores the
// returned ETag; the next tick sends that stored ETag back as If-None-Match.
await inTempDir(async () => {
  const etags = {};
  const ghc = fakeGhc({
    ready: [
      { status: 200, etag: 'W/"r1"', body: [{ number: 1, title: "a" }] },
      { status: 200, etag: 'W/"r2"', body: [{ number: 1, title: "a" }] },
    ],
    inProgress: [
      { status: 200, etag: 'W/"i1"', body: [] },
      { status: 200, etag: 'W/"i2"', body: [] },
    ],
    openPrs: [
      { status: 200, etag: 'W/"p1"', body: [] },
      { status: 200, etag: 'W/"p2"', body: [] },
    ],
  });
  await pollOnce(pollArgs({ ghc, etags }));
  assert.deepEqual(
    ghc.calls.map((c) => c.etag),
    [null, null, null],
    "the first tick sends no If-None-Match on any endpoint",
  );
  assert.equal(etags.ready.etag, 'W/"r1"', "the returned ETag is stored per endpoint");
  await pollOnce(pollArgs({ ghc, etags }));
  assert.deepEqual(
    ghc.calls.slice(3).map((c) => c.etag),
    ['W/"r1"', 'W/"i1"', 'W/"p1"'],
    "the second tick sends each endpoint's stored ETag as If-None-Match",
  );
});

// #420 AC2: when every polled endpoint returns 304 the tick short-circuits —
// pollOnce reports { skipped: true } and writes no state file.
await inTempDir(async () => {
  const etags = {
    ready: { etag: 'W/"r"', body: [] },
    inProgress: { etag: 'W/"i"', body: [] },
    openPrs: { etag: 'W/"p"', body: [] },
  };
  const ghc = fakeGhc({
    ready: [{ status: 304, etag: null, body: null }],
    inProgress: [{ status: 304, etag: null, body: null }],
    openPrs: [{ status: 304, etag: null, body: null }],
  });
  const r = await pollOnce(pollArgs({ ghc, etags }));
  assert.equal(r.skipped, true, "an all-304 tick is skipped");
  assert.equal(existsSync("s.json"), false, "a skipped tick mutates no state (no state file written)");
});

// #420 AC3: when any endpoint returns 200 the full pass runs and that
// endpoint's stored ETag is replaced with the new one (others keep theirs).
await inTempDir(async () => {
  const etags = {
    ready: { etag: 'W/"r1"', body: [{ number: 9, title: "old" }] },
    inProgress: { etag: 'W/"i1"', body: [] },
    openPrs: { etag: 'W/"p1"', body: [] },
  };
  const ghc = fakeGhc({
    ready: [{ status: 200, etag: 'W/"r2"', body: [{ number: 5, title: "new" }] }],
    inProgress: [{ status: 304, etag: null, body: null }],
    openPrs: [{ status: 304, etag: null, body: null }],
  });
  const r = await pollOnce(pollArgs({ ghc, etags }));
  assert.equal(r.skipped, undefined, "a 200 on any endpoint runs the full pass, not a skip");
  assert.equal(r.ready, 1, "the full pass surveys the fresh ready queue");
  assert.equal(etags.ready.etag, 'W/"r2"', "the changed endpoint's ETag is replaced");
  assert.equal(etags.inProgress.etag, 'W/"i1"', "an unchanged (304) endpoint keeps its stored ETag");
  assert.equal(existsSync("s.json"), true, "the full pass writes state");
});

// #420 AC4: a response with no ETag header, or a gh failure, falls back to a
// full unconditional pass and logs a `survey-fallback` herd event — never a
// crash, never a skipped pass.
await inTempDir(async () => {
  // (a) 200 with no ETag: the full pass runs, no ETag is cached, and a
  // survey-fallback event is logged so the next tick is unconditional.
  const etags = {};
  const noEtag = fakeGhc({
    ready: [{ status: 200, etag: null, body: [{ number: 1, title: "x" }] }],
    inProgress: [{ status: 200, etag: null, body: [] }],
    openPrs: [{ status: 200, etag: null, body: [] }],
  });
  const r1 = await pollOnce(pollArgs({ ghc: noEtag, etags }));
  assert.equal(r1.skipped, undefined, "a missing-ETag response runs the full pass, never a skip");
  assert.equal(etags.ready.etag, null, "no ETag is cached when the header is absent");
  const ev1 = readFileSync("ev.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(ev1.some((e) => e.event === "survey-fallback"), "a survey-fallback event is logged for the missing ETag");

  // (b) gh failure: the conditional call throws, so the survey falls back to a
  // plain unconditional survey over `gh`, logs a survey-fallback event, no crash.
  const etags2 = {
    ready: { etag: 'W/"r"', body: [] },
    inProgress: { etag: 'W/"i"', body: [] },
    openPrs: { etag: 'W/"p"', body: [] },
  };
  const boom = async () => { throw new Error("gh: conditional request failed"); };
  const gh = fakeGh({ ready: [{ number: 7, title: "fallback" }] });
  const r2 = await pollOnce(pollArgs({ gh, ghc: boom, etags: etags2, statePath: "s2.json", escalationsPath: "e2.md", eventsPath: "ev2.jsonl" }));
  assert.equal(r2.ok, true, "a conditional gh failure does not crash the poll");
  assert.equal(r2.skipped, undefined, "a gh failure falls back to a full pass, never a skip");
  assert.equal(r2.ready, 1, "the fallback surveys reality unconditionally via gh");
  const ev2 = readFileSync("ev2.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(ev2.some((e) => e.event === "survey-fallback"), "a survey-fallback event is logged for the gh failure");
});

// #420 AC5: every criterion above has exactly one test named after it.
{
  const self = readFileSync(new URL("./herd-survey.test.mjs", import.meta.url), "utf8");
  for (const ac of ["AC1", "AC2", "AC3", "AC4", "AC5"]) {
    const hits = (self.match(new RegExp(`// #420 ${ac}:`, "g")) || []).length;
    assert.equal(hits, 1, `#420 ${ac} has exactly one test named after it`);
  }
}

// --- Criterion 3 (#427): a claim ref the supervisor did NOT observe its own
// worker create (no live state entry backs it) is never deleted by the new
// dead-worker auto-recovery — the survey's stale-claim path still only escalates
// it, exactly as issue #138 (0066). We record every gh call and prove no actual
// DELETE / requeue was issued; only an escalation naming the manual command. ---
await inTempDir(async () => {
  const calls = [];
  const base = fakeGhWithRefs({ claimRefs: [88] }); // a foreign ref: present, no state entry, no PR
  const gh = async (args) => {
    calls.push(args);
    return base(args);
  };
  const r = await pollOnce({ gh, isAlive: () => false, now: NOW, statePath: "s.json", escalationsPath: "e.md", log: () => {} });
  assert.equal(r.staleEscalated, 1, "the unobserved ref still escalates as a stale claim");
  assert.ok(!calls.some((a) => a[0] === "api" && a[2] === "DELETE"), "the supervisor never deletes a ref it did not observe its own worker create");
  assert.ok(!calls.some((a) => a[0] === "issue" && (a[1] === "comment" || a[1] === "edit")), "an unobserved ref is never requeued automatically");
  const esc = readFileSync("e.md", "utf8");
  assert.match(esc, /stale claim ref agent\/issue-88 on origin/, "the escalation names the foreign ref for a human");
});

console.log("PASS herd-survey.test.mjs (7 criteria + issue #137: 4 criteria + issue #143: 5 criteria + issue #138: 5 criteria + issue #139: 3 criteria + issue #163: 3 criteria + issue #169: 4 criteria + issue #170: 4 criteria + issue #173: 5 criteria + issue #441: 4 criteria + issue #357: 3 criteria + issue #405: 5 criteria + issue #419: 4 criteria + issue #420: 5 criteria + issue #427: 1 criterion + 1 test note)");
