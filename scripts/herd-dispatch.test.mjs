#!/usr/bin/env node
// herd-dispatch.test.mjs — the criteria are the test plan. One test per
// acceptance criterion of issue #105 (dispatch with claim-window
// serialization); criteria 4, 5, and 8 track issue #126, which moved the claim
// signal from the state:ready label to the server-side branch ref
// agent/issue-<N>. Exercised through herd-dispatch.mjs's public interface.
// Offline: spawn, gh, kill, clock, and sleep are injected. Criterion 2 drives a
// real detached spawn against a stub adapter CLI written into a temp dir.
// Zero dependencies. Run:  node scripts/herd-dispatch.test.mjs

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickNext, buildDispatch, spawnWorker, waitForClaim, dispatchOne } from "./herd-dispatch.mjs";
import { readState } from "./herd-survey.mjs";

const NOW = Date.UTC(2026, 6, 9, 12, 0, 0); // fixed clock — no Date.now dependence

const mkConfig = (over = {}) => ({
  maxWorkers: 3,
  pollSeconds: 60,
  reworkCap: 2,
  logDir: "logs",
  adapters: { claude: { launch: ["claude", "-p", "{prompt}"], promptTemplate: "issue {issue}", env: {} } },
  routing: { default: "claude", labels: {} },
  ...over,
});

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-dispatch-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    return await fn(dir);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Poll a predicate with real (bounded) sleeps — a detached child writes its log
// asynchronously, so criterion 2 waits for the write without a fixed delay.
async function until(pred, attempts = 80, ms = 25) {
  for (let i = 0; i < attempts; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error("condition not met in time");
}

// Criterion 1: dispatch picks the top ready issue by priority then age, and the
// adapter via config routing.
{
  const ready = [
    { number: 3, createdAt: "2026-01-03", labels: [{ name: "priority:low" }] },
    { number: 1, createdAt: "2026-01-05", labels: [{ name: "priority:high" }] },
    { number: 2, createdAt: "2026-01-01", labels: [{ name: "priority:high" }] },
  ];
  assert.equal(pickNext(ready).number, 2, "highest priority, oldest first wins");
  assert.equal(pickNext([]), null, "no ready issues -> null");
  const plan = buildDispatch(mkConfig(), { number: 2, labels: [] });
  assert.equal(plan.adapter, "claude", "adapter resolved via config routing");
  assert.deepEqual(plan.argv, ["claude", "-p", "issue 2"], "prompt and issue substituted into argv");
}

// Criterion 2: workers spawn detached with stdout+stderr redirected to
// logDir/issue-<N>.log, creating logDir, with the adapter's env merged in.
await inTempDir(async () => {
  const stub = join(process.cwd(), "stub.sh");
  writeFileSync(stub, 'echo "out $MERGED"; echo "err $MERGED" 1>&2\n');
  const config = mkConfig({
    logDir: "logs",
    adapters: { a: { launch: ["sh", stub, "{issue}"], promptTemplate: "", env: { MERGED: "yes" } } },
    routing: { default: "a", labels: {} },
  });
  const plan = buildDispatch(config, { number: 7, labels: [] });
  const pid = spawnWorker(plan.argv, plan.env, plan.logFile);
  assert.ok(Number.isInteger(pid) && pid > 0, "spawn returns a pid");
  await until(() => existsSync("logs/issue-7.log") && /out yes/.test(readFileSync("logs/issue-7.log", "utf8")));
  const logText = readFileSync("logs/issue-7.log", "utf8");
  assert.match(logText, /out yes/, "stdout redirected to logDir/issue-<N>.log with env merged");
  assert.match(logText, /err yes/, "stderr redirected to the same log");
  assert.ok(existsSync("logs"), "logDir was created");
});

// Criterion 3: live worker count never exceeds maxWorkers; --max overrides it.
await inTempDir(async () => {
  const noSpawn = () => {
    throw new Error("must not spawn at capacity");
  };
  const common = { escalationsPath: "e.md", spawn: noSpawn, isAlive: () => true, gh: async () => ({ labels: [] }), now: () => NOW, sleep: async () => {}, log: () => {} };

  writeFileSync("full.json", JSON.stringify({ 1: { pid: 11 }, 2: { pid: 12 }, 3: { pid: 13 } }));
  const r1 = await dispatchOne({ ...common, config: mkConfig(), ready: [{ number: 9, labels: [] }], statePath: "full.json" });
  assert.equal(r1.reason, "at-capacity", "config maxWorkers is never exceeded");

  writeFileSync("one.json", JSON.stringify({ 1: { pid: 11 } }));
  const r2 = await dispatchOne({ ...common, config: mkConfig(), ready: [{ number: 9, labels: [] }], statePath: "one.json", maxWorkers: 1 });
  assert.equal(r2.reason, "at-capacity", "--max lowers the cap below config.maxWorkers");
});

// Criterion 4 (issue #126): waitForClaim reports claimed as soon as the server
// ref agent/issue-<N> exists, even while state:ready is still on the issue —
// the ref is the claim, the label only reports.
{
  let calls = 0;
  const seen = [];
  const gh = async (args) => {
    calls++;
    seen.push(args.join(" "));
    if (calls < 3) throw new Error("404 Not Found"); // ref not created yet
    return { ref: "refs/heads/agent/issue-5" }; // the worker created its claim ref
  };
  let t = 0;
  const now = () => t;
  const sleep = (ms) => ((t += ms), Promise.resolve());
  const r = await waitForClaim({ gh, issue: 5, timeoutMs: 10000, intervalMs: 1000, now, sleep });
  assert.equal(r.claimed, true, "returns claimed once the claim ref resolves");
  assert.ok(calls >= 3, "polled until the ref existed");
  assert.ok(seen.every((a) => /git\/ref\/heads\/agent\/issue-5/.test(a)), "polls the branch ref, never the label");
}

// Criterion 5 (issue #126): a worker that has not created the claim ref by the
// timeout is killed, marked dispatch-failed, and escalated with its log named.
await inTempDir(async () => {
  let killed = null;
  let t = 0;
  const now = () => t;
  const sleep = (ms) => ((t += ms), Promise.resolve());
  const r = await dispatchOne({
    config: mkConfig(),
    ready: [{ number: 8, labels: [] }],
    statePath: "s.json",
    escalationsPath: "esc.md",
    spawn: () => 4242,
    gh: async () => {
      throw new Error("404 Not Found"); // the claim ref is never created
    },
    isAlive: () => false,
    kill: (pid) => {
      killed = pid;
    },
    now,
    sleep,
    log: () => {},
    claimTimeoutMs: 3000,
    claimIntervalMs: 1000,
  });
  assert.equal(r.claimed, false, "the claim window times out");
  assert.equal(killed, 4242, "the un-claiming worker is killed");
  assert.equal(readState("s.json")["8"].status, "dispatch-failed", "marked dispatch-failed in the state file");
  const esc = readFileSync("esc.md", "utf8");
  assert.match(esc, /did not claim/, "an escalation is appended");
  assert.match(esc, /issue-8\.log/, "the escalation names the worker's log file");
});

// Criterion 8 (issue #126): a transient gh failure while polling counts as
// still waiting — never a claim, and never a dispatch failure.
await inTempDir(async () => {
  let killed = false;
  let calls = 0;
  let t = 0;
  const now = () => t;
  const sleep = (ms) => ((t += ms), Promise.resolve());
  const gh = async () => {
    calls++;
    if (calls <= 2) throw new Error("transient network blip"); // must not end the wait
    return { ref: "refs/heads/agent/issue-9" }; // ref appears after the blips
  };
  const r = await dispatchOne({
    config: mkConfig(),
    ready: [{ number: 9, labels: [] }],
    statePath: "s.json",
    escalationsPath: "esc.md",
    spawn: () => 777,
    gh,
    isAlive: () => false,
    kill: () => {
      killed = true;
    },
    now,
    sleep,
    log: () => {},
    claimTimeoutMs: 60000,
    claimIntervalMs: 1000,
  });
  assert.equal(r.claimed, true, "keeps waiting through the blip, then sees the claim ref");
  assert.equal(killed, false, "a transient failure never kills the worker");
  assert.equal(readState("s.json")["9"].status, "dispatched", "never marked dispatch-failed on a transient blip");
  assert.ok(!existsSync("esc.md"), "no escalation for a transient blip");
});

// Criterion 6: an issue already present in the state file is never dispatched a
// second worker.
await inTempDir(async () => {
  const noSpawn = () => {
    throw new Error("must not spawn a second worker");
  };
  writeFileSync("s.json", JSON.stringify({ 5: { pid: 11, status: "dispatched" } }));
  const r = await dispatchOne({
    config: mkConfig(), ready: [{ number: 5, labels: [] }], statePath: "s.json", escalationsPath: "e.md",
    spawn: noSpawn, isAlive: () => true, gh: async () => ({ labels: [] }), now: () => NOW, sleep: async () => {}, log: () => {},
  });
  assert.equal(r.reason, "no-eligible-issue", "the tracked issue is not dispatched again");
});

// Criterion 7: --dry-run on a repo with ready issues prints the dispatch plan
// (issue, adapter, command) without spawning anything.
await inTempDir(async () => {
  const logs = [];
  const noSpawn = () => {
    throw new Error("dry-run must not spawn");
  };
  const r = await dispatchOne({
    config: mkConfig(), ready: [{ number: 6, labels: [{ name: "priority:high" }] }], statePath: "s.json", escalationsPath: "e.md",
    spawn: noSpawn, isAlive: () => true, gh: async () => ({ labels: [] }), now: () => NOW, sleep: async () => {}, log: (m) => logs.push(m), dryRun: true,
  });
  assert.equal(r.dryRun, true, "dry-run does not dispatch");
  assert.deepEqual(r.plan, { issue: 6, adapter: "claude", command: ["claude", "-p", "issue 6"] }, "returns the plan");
  assert.ok(logs.some((m) => /issue #6/.test(m) && /claude/.test(m)), "prints the plan (issue, adapter, command)");
  assert.ok(!existsSync("s.json"), "no worker spawned and no state written");
});

// --- Issue #127: survive a herd worker spawn failure instead of crashing. ---

// #127 criterion 1 (spawn-level): a launch command whose binary does not exist
// yields no pid synchronously and its async spawn error is caught and forwarded
// to onError, never left uncaught — so the supervisor process stays alive.
await inTempDir(async () => {
  let err = null;
  const pid = spawnWorker(["definitely-not-a-real-binary-xyz-127"], {}, "logs/issue-1.log", undefined, (e) => {
    err = e;
  });
  assert.equal(pid, undefined, "a missing binary returns no pid");
  await until(() => err !== null);
  assert.equal(err.code, "ENOENT", "the async spawn error is forwarded to onError, not thrown uncaught");
});

// #127 criterion 1 (dispatch-level) + criterion 2: a spawn failure leaves the
// supervisor alive and polling (dispatchOne returns without entering the claim
// wait), marks the issue dispatch-failed with its pid cleared, and appends an
// escalation naming the adapter, the command, and the log file.
await inTempDir(async () => {
  let waited = false;
  const r = await dispatchOne({
    config: mkConfig(),
    ready: [{ number: 8, labels: [] }],
    statePath: "s.json",
    escalationsPath: "esc.md",
    spawn: () => undefined, // launch command never started -> no pid
    gh: async () => {
      waited = true;
      return { labels: [{ name: "state:ready" }] };
    },
    isAlive: () => false,
    now: () => NOW,
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(r.status, "dispatch-failed", "a spawn failure resolves to dispatch-failed");
  assert.equal(waited, false, "the supervisor does not enter the claim wait for a worker that never started");
  const entry = readState("s.json")["8"];
  assert.equal(entry.status, "dispatch-failed", "the issue is marked dispatch-failed in the state file");
  assert.equal(entry.pid, null, "its pid is cleared");
  const esc = readFileSync("esc.md", "utf8");
  assert.match(esc, /adapter "claude"/, "the escalation names the adapter");
  assert.match(esc, /claude -p issue 8/, "the escalation names the command");
  assert.match(esc, /issue-8\.log/, "the escalation names the log file");
});

// #127 criterion 3: a successful spawn (a pid is returned) behaves exactly as
// today — the entry is recorded as dispatched and the claim window runs.
await inTempDir(async () => {
  let calls = 0;
  const r = await dispatchOne({
    config: mkConfig(),
    ready: [{ number: 9, labels: [] }],
    statePath: "s.json",
    escalationsPath: "esc.md",
    spawn: () => 5150,
    gh: async () => (++calls, { ref: "refs/heads/agent/issue-9" }), // claim ref resolves
    isAlive: () => false,
    now: () => NOW,
    sleep: async () => {},
    log: () => {},
    claimTimeoutMs: 60000,
    claimIntervalMs: 1000,
  });
  assert.equal(r.claimed, true, "a returned pid dispatches normally and the claim is observed");
  assert.equal(r.pid, 5150, "the pid is reported unchanged");
  const entry = readState("s.json")["9"];
  assert.equal(entry.status, "dispatched", "the entry is recorded as dispatched, not dispatch-failed");
  assert.equal(entry.pid, 5150, "the live pid is stored");
});

console.log("PASS herd-dispatch.test.mjs (8 checks for #105/#126 + 3 for #127)");
