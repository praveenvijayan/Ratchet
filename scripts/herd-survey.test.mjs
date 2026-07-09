#!/usr/bin/env node
// herd-survey.test.mjs — the criteria are the test plan. One test per
// acceptance criterion of issue #104 (herd state file, survey/reconcile loop,
// escalation writer), exercised through herd-survey.mjs's public interface.
// Fully offline: gh, process liveness, the clock, and the sleep are all
// injected, so nothing spawns a process or hits the network.
// Zero dependencies. Run:  node scripts/herd-survey.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
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
 runLoop,
} from "./herd-survey.mjs";
import { dispatchOne, recordExit } from "./herd-dispatch.mjs";
import { monitorOnce } from "./herd-monitor.mjs";
import { verifyOnce } from "./herd-verify.mjs";

const NOW = Date.UTC(2026, 6, 9, 12, 0, 0); // fixed clock — no Date.now dependence

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

console.log("PASS herd-survey.test.mjs (7 criteria + issue #137: 4 criteria + issue #143: 5 criteria)");
