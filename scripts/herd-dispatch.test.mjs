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
import { pickNext, buildDispatch, spawnWorker, waitForClaim, dispatchOne, supervisorStep } from "./herd-dispatch.mjs";
import { readState, createSupervisorPump } from "./herd-survey.mjs";

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
  const plan = buildDispatch(mkConfig(), { number: 2, labels: [] }, { onPath: () => true });
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
  const common = { escalationsPath: "e.md", spawn: noSpawn, isAlive: () => true, gh: async () => ({ labels: [] }), now: () => NOW, sleep: async () => {}, log: () => {}, onPath: () => true };

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
    onPath: () => true,
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

// Criterion (issue #133): the dispatch-timeout escalation's `what` names the
// exact missing signal — the agent/issue-<N> ref on origin — alongside the
// timeout in seconds and the killed pid, so an operator reading escalations.md
// knows what "claim" was being waited on and where to look for it.
await inTempDir(async () => {
  let t = 0;
  const now = () => t;
  const sleep = (ms) => ((t += ms), Promise.resolve());
  await dispatchOne({
    onPath: () => true,
    config: mkConfig(),
    ready: [{ number: 8, labels: [] }],
    statePath: "s.json",
    escalationsPath: "esc.md",
    spawn: () => 4242,
    gh: async () => {
      throw new Error("404 Not Found"); // the claim ref is never created
    },
    isAlive: () => false,
    kill: () => {},
    now,
    sleep,
    log: () => {},
    claimTimeoutMs: 3000,
    claimIntervalMs: 1000,
  });
  const esc = readFileSync("esc.md", "utf8");
  assert.match(esc, /agent\/issue-8 on origin/, "the `what` names the exact missing signal: the agent/issue-<N> ref on origin");
  assert.match(esc, /within 3s/, "the `what` names the timeout in seconds");
  assert.match(esc, /killed pid 4242/, "the `what` names the killed pid");
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
    onPath: () => true,
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
    onPath: () => true,
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
    onPath: () => true,
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
    onPath: () => true,
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
    onPath: () => true,
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

// --- Issue #138: detect and escalate stale agent/issue-N claim branches. ---

// #138 AC2) The dispatch-timeout escalation re-checks the ref after the kill;
// when the killed worker created it anyway (raced the timeout), the escalation
// says so and includes the exact delete command. The gh stub 404s throughout
// the claim wait (so the worker never "claims") and then resolves the ref once
// the kill has fired — modelling a worker that created the ref around SIGTERM.
await inTempDir(async () => {
  let killed = false;
  let t = 0;
  const now = () => t;
  const sleep = (ms) => ((t += ms), Promise.resolve());
  const gh = async () => {
    if (!killed) throw new Error("404 Not Found"); // ref absent during the wait
    return { ref: "refs/heads/agent/issue-8" }; // worker created it around the kill
  };
  const r = await dispatchOne({
    onPath: () => true,
    config: mkConfig(),
    ready: [{ number: 8, labels: [] }],
    statePath: "s.json",
    escalationsPath: "esc.md",
    spawn: () => 4242,
    gh,
    isAlive: () => false,
    kill: () => {
      killed = true;
    },
    now,
    sleep,
    log: () => {},
    claimTimeoutMs: 3000,
    claimIntervalMs: 1000,
  });
  assert.equal(r.claimed, false, "the claim window still times out");
  assert.equal(r.staleRef, true, "the post-kill ref re-check finds the ref the killed worker left");
  const esc = readFileSync("esc.md", "utf8");
  assert.match(esc, /created anyway/, "the escalation says the killed worker created the ref anyway");
  assert.match(
    esc,
    /gh api -X DELETE repos\/\{owner\}\/\{repo\}\/git\/refs\/heads\/agent\/issue-8/,
    "the escalation includes the exact delete command",
  );
});

// --- Issue #151: fall back to the next available adapter; escalate when none is. ---

// #151 AC4) When no adapter in the resolved route is available, the issue is not
// dispatched: no worker spawns, it is marked dispatch-failed, and one escalation
// names the route and every adapter tried, each with why it was unavailable
// (missing binary vs unset env var).
await inTempDir(async () => {
  const config = mkConfig({
    adapters: {
      claude: { launch: ["claude", "-p", "{prompt}"], promptTemplate: "issue {issue}", env: {}, requiresEnv: [] },
      pi: { launch: ["pi", "{prompt}"], promptTemplate: "issue {issue}", env: {}, requiresEnv: ["PI_KEY"] },
    },
    routing: { default: ["claude", "pi"], labels: {} },
  });
  const noSpawn = () => {
    throw new Error("must not spawn when no adapter is available");
  };
  const r = await dispatchOne({
    config,
    ready: [{ number: 8, labels: [] }],
    statePath: "s.json",
    escalationsPath: "esc.md",
    spawn: noSpawn,
    gh: async () => ({ labels: [] }),
    isAlive: () => false,
    now: () => NOW,
    sleep: async () => {},
    log: () => {},
    // claude's binary is absent from PATH; pi's binary is present but PI_KEY is unset.
    env: {},
    onPath: (exe) => exe === "pi",
  });
  assert.equal(r.dispatched, 8, "the unavailable-route issue is reported, but");
  assert.equal(r.unavailable, true, "it is flagged unavailable, not dispatched to a worker");
  assert.equal(readState("s.json")["8"].status, "dispatch-failed", "the issue is marked dispatch-failed, not spawned");
  const esc = readFileSync("esc.md", "utf8");
  assert.match(esc, /no adapter is available for route routing\.default \[claude, pi\]/, "the escalation names the route and its adapters in order");
  assert.match(esc, /claude \(.*binary .*not found on PATH.*\)/, "claude's reason is its missing binary");
  assert.match(esc, /pi \(.*PI_KEY is unset or empty.*\)/, "pi's reason is its unset env var");
});

// #156 AC2) Under a round-robin policy, successive dispatches to the same route
// cycle through the available adapters in order before any adapter repeats. The
// rotation cursor is carried across dispatchOne calls in its own routing state
// file, so the order is deterministic and reproducible offline.
await inTempDir(async () => {
  const config = mkConfig({
    maxWorkers: 10, // let every worker stay "live" so none is rejected at capacity
    adapters: {
      a: { launch: ["a"], promptTemplate: "", env: {} },
      b: { launch: ["b"], promptTemplate: "", env: {} },
      c: { launch: ["c"], promptTemplate: "", env: {} },
    },
    routing: { default: { adapters: ["a", "b", "c"], policy: "round-robin" }, labels: {} },
  });
  const common = {
    escalationsPath: "e.md", statePath: "s.json", routingPath: "r.json",
    spawn: () => 4242, isAlive: () => true,
    gh: async () => ({}), // any resolving ref means the worker claimed the issue
    now: () => NOW, sleep: async () => {}, log: () => {}, onPath: () => true,
  };
  const picks = [];
  for (const number of [10, 11, 12, 13]) {
    const r = await dispatchOne({ ...common, config, ready: [{ number, labels: [] }] });
    picks.push(r.adapter);
  }
  assert.deepEqual(picks, ["a", "b", "c", "a"], "successive dispatches cycle the adapters in order, then repeat");
  assert.equal(
    JSON.parse(readFileSync("r.json", "utf8"))["routing.default"],
    1,
    "the rotation cursor persists in the routing state file (advanced to a's index after the 4th dispatch)",
  );
});

// --- Issue #285: the fleet heartbeat must not starve while a poll pass blocks in
// the dispatch claim wait. One test per acceptance criterion. ---

// #285 criterion 1: a claim wait that blocks for the full claimTimeoutSeconds keeps
// beating the fleet heartbeat, so its age never exceeds the dashboard's silence
// threshold (pollSeconds * HEARTBEAT_SILENCE_FACTOR) while the supervisor is alive.
await inTempDir(async () => {
  let t = NOW;
  const now = () => t;
  const sleep = (ms) => ((t += ms), Promise.resolve());
  await dispatchOne({
    onPath: () => true,
    config: mkConfig(), // pollSeconds 60 -> beat cadence 60s, silence threshold 150s
    ready: [{ number: 20, labels: [] }],
    statePath: "s.json",
    escalationsPath: "esc.md",
    eventsPath: "events.jsonl",
    spawn: () => 5000,
    gh: async () => {
      throw new Error("404 Not Found"); // the ref never appears -> the wait runs to the full timeout
    },
    isAlive: () => false,
    kill: () => {},
    now,
    sleep,
    log: () => {},
    claimTimeoutMs: 300000, // 300s — the default claim window, longer than the 150s silence threshold
    claimIntervalMs: 1000,
  });
  const beats = readFileSync("events.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === "heartbeat")
    .map((e) => Date.parse(e.ts));
  assert.ok(beats.length >= 4, "the supervisor beats repeatedly across the 300s claim wait, not just once");
  const SILENCE = 60 * 2.5 * 1000; // HEARTBEAT_SILENCE_FACTOR (2.5) * pollSeconds, in ms
  assert.ok(beats[0] - NOW <= SILENCE, "the first in-wait beat lands within one silence threshold of the pass start");
  for (let i = 1; i < beats.length; i++) {
    assert.ok(beats[i] - beats[i - 1] <= SILENCE, "no gap between consecutive heartbeats exceeds the silence threshold");
  }
});

// #285 criterion 2: heartbeats are bound to an active wait — once the claim
// resolves (or the process stops) no further beats fire, so a genuinely stopped
// supervisor is still reported silent within one threshold, same as today. A wait
// that ends well under the beat cadence emits no beats at all: beats never outlive
// the wait.
{
  let t = NOW;
  const now = () => t;
  const sleep = (ms) => ((t += ms), Promise.resolve());
  let beats = 0;
  let calls = 0;
  const gh = async () => {
    if (++calls < 3) throw new Error("404 Not Found");
    return { ref: "refs/heads/agent/issue-21" }; // claim resolves after ~2s of waiting
  };
  const r = await waitForClaim({
    gh,
    issue: 21,
    timeoutMs: 300000,
    intervalMs: 1000,
    now,
    sleep,
    heartbeat: () => beats++,
    heartbeatIntervalMs: 60000, // 60s cadence — far longer than the ~2s this wait lasts
  });
  assert.equal(r.claimed, true, "the claim resolves");
  assert.equal(beats, 0, "a short wait fires no heartbeat, and a returned wait beats no more — beats never outlive the wait");
}

// #285 criterion 3: a heartbeat write failure during the claim wait is swallowed —
// it never aborts the wait or the pass — matching pollOnce's heartbeat error policy.
await inTempDir(async () => {
  writeFileSync("blocked", ""); // a file where the events dir would need to be -> every append ENOTDIRs
  let t = NOW;
  const now = () => t;
  const sleep = (ms) => ((t += ms), Promise.resolve());
  const r = await dispatchOne({
    onPath: () => true,
    config: mkConfig(),
    ready: [{ number: 22, labels: [] }],
    statePath: "s.json",
    escalationsPath: "esc.md",
    eventsPath: "blocked/events.jsonl", // unwritable: its dirname is a regular file
    spawn: () => 6000,
    gh: async () => {
      throw new Error("404 Not Found");
    },
    isAlive: () => false,
    kill: () => {},
    now,
    sleep,
    log: () => {},
    claimTimeoutMs: 180000,
    claimIntervalMs: 1000,
  });
  assert.equal(r.claimed, false, "the wait still runs to timeout despite every heartbeat write failing");
  assert.equal(readState("s.json")["22"].status, "dispatch-failed", "the pass completes and records the outcome");
  assert.ok(!existsSync("blocked/events.jsonl"), "no events file was fabricated past the unwritable path");
});

// --- Issue #286: short-circuit the claim wait when the spawned worker exits. ---

// #286 AC1) When the worker's process exits before creating its claim ref, the
// claim wait ends within one claim-poll interval of the exit instead of running
// to the full timeout. The spawn stub fires onExit(1) to model a worker that
// dies right after launch; the fake clock proves the wait did not burn 300s.
await inTempDir(async () => {
  let sleeps = 0;
  let t = 0;
  const now = () => t;
  const sleep = (ms) => ((t += ms), sleeps++, Promise.resolve());
  const r = await dispatchOne({
    onPath: () => true,
    config: mkConfig(),
    ready: [{ number: 8, labels: [] }],
    statePath: "s.json",
    escalationsPath: "esc.md",
    spawn: (argv, env, logFile, onExit) => (onExit(1, null), 4242), // worker exits right after spawn
    gh: async () => {
      throw new Error("404 Not Found"); // ref never created; post-exit re-check also absent
    },
    isAlive: () => false,
    kill: () => {},
    now,
    sleep,
    log: () => {},
    claimTimeoutMs: 300000,
    claimIntervalMs: 1000,
  });
  assert.equal(r.claimed, false, "the claim wait ends unclaimed");
  assert.equal(r.exited, true, "it short-circuited on the worker's exit");
  assert.ok(t < 300000, "the wait did not run to the full claim timeout");
  assert.ok(sleeps <= 1, "it ended within one claim-poll interval of the exit");
});

// #286 AC2) The escalation for an exited-before-claiming worker names the
// observed exit and says the ref was never created, distinct from the existing
// "still running but never claimed within Ns" timeout message.
await inTempDir(async () => {
  let t = 0;
  const now = () => t;
  const sleep = (ms) => ((t += ms), Promise.resolve());
  const r = await dispatchOne({
    onPath: () => true,
    config: mkConfig(),
    ready: [{ number: 8, labels: [] }],
    statePath: "s.json",
    escalationsPath: "esc.md",
    spawn: (argv, env, logFile, onExit) => (onExit(1, null), 4242),
    gh: async () => {
      throw new Error("404 Not Found");
    },
    isAlive: () => false,
    kill: () => {},
    now,
    sleep,
    log: () => {},
    claimTimeoutMs: 300000,
    claimIntervalMs: 1000,
  });
  assert.equal(r.status, "dispatch-failed", "the exited-without-claiming worker is dispatch-failed");
  assert.equal(readState("s.json")["8"].status, "dispatch-failed", "marked dispatch-failed in the state file");
  const esc = readFileSync("esc.md", "utf8");
  assert.match(esc, /exited \(exit code 1\)/, "the escalation names the observed exit");
  assert.match(esc, /before creating its claim ref agent\/issue-8 on origin/, "it says the ref was never created");
  assert.doesNotMatch(esc, /did not claim the issue within/, "it is distinct from the running-but-never-claimed timeout message");
});

// #286 AC3) A worker that creates its claim ref and then exits is still reported
// as claimed — the post-exit origin re-check finds the ref, so an early exit
// after claiming never produces a dispatch-failed. The first gh call (the wait
// poll) 404s; the second (the re-check) resolves the ref the worker left.
await inTempDir(async () => {
  let t = 0;
  const now = () => t;
  const sleep = (ms) => ((t += ms), Promise.resolve());
  let calls = 0;
  const gh = async () => {
    calls++;
    if (calls === 1) throw new Error("404 Not Found"); // ref not visible during the poll
    return { ref: "refs/heads/agent/issue-8" }; // the post-exit re-check finds it
  };
  const r = await dispatchOne({
    onPath: () => true,
    config: mkConfig(),
    ready: [{ number: 8, labels: [] }],
    statePath: "s.json",
    escalationsPath: "esc.md",
    spawn: (argv, env, logFile, onExit) => (onExit(0, null), 4242), // claimed, then exited
    gh,
    isAlive: () => false,
    kill: () => {},
    now,
    sleep,
    log: () => {},
    claimTimeoutMs: 300000,
    claimIntervalMs: 1000,
  });
  assert.equal(r.claimed, true, "a worker that claimed then exited is reported as claimed");
  assert.equal(readState("s.json")["8"].status, "dispatched", "never marked dispatch-failed");
  assert.ok(!existsSync("esc.md"), "no escalation for a worker that did claim");
});

// #286 AC4) A worker that stays alive and claims late (within the timeout) still
// succeeds exactly as today — onExit never fires, so the wait polls until the
// ref appears rather than short-circuiting.
await inTempDir(async () => {
  let t = 0;
  const now = () => t;
  const sleep = (ms) => ((t += ms), Promise.resolve());
  let calls = 0;
  const gh = async () => {
    calls++;
    if (calls < 3) throw new Error("404 Not Found"); // claims on the third poll
    return { ref: "refs/heads/agent/issue-8" };
  };
  const r = await dispatchOne({
    onPath: () => true,
    config: mkConfig(),
    ready: [{ number: 8, labels: [] }],
    statePath: "s.json",
    escalationsPath: "esc.md",
    spawn: () => 4242, // worker stays alive; onExit never fires
    gh,
    isAlive: () => false,
    kill: () => {},
    now,
    sleep,
    log: () => {},
    claimTimeoutMs: 300000,
    claimIntervalMs: 1000,
  });
  assert.equal(r.claimed, true, "a live worker that claims late still succeeds");
  assert.equal(readState("s.json")["8"].status, "dispatched", "recorded as dispatched");
  assert.ok(!existsSync("esc.md"), "no escalation for a successful late claim");
});

// ── issue #350: herd direct-issue targeting — dispatch filter ──
// (parseIssueTargets and the CLI exit-2 path live in herd.mjs / herd.test.mjs;
// these tests cover the dispatchOne target filter — criteria 2, 3, 4.)

// Criterion 2: with a target set, the supervisor dispatches only issues in the
// set — an eligible `state:ready` issue outside the set is never dispatched
// during a scoped run. Issue #1 is higher priority and would win the unscoped
// queue, but it is outside the set, so #2 is dispatched and #1 never is.
await inTempDir(async () => {
  const ready = [
    { number: 1, createdAt: "2026-01-01", labels: [{ name: "priority:high" }] },
    { number: 2, createdAt: "2026-01-02", labels: [{ name: "priority:medium" }] },
  ];
  const r = await dispatchOne({
    config: mkConfig(),
    ready,
    targets: [2],
    statePath: "s.json",
    dryRun: true,
    log: () => {},
  });
  assert.equal(r.plan.issue, 2, "only the in-set issue is dispatched");
  assert.notEqual(r.plan.issue, 1, "the higher-priority out-of-set issue is never dispatched");
});

// Criterion 3: within the set, dispatch order follows the existing pickNext
// ordering (priority, then oldest), one worker per poll pass, respecting
// maxWorkers.
await inTempDir(async () => {
  // Ordering: both targeted, #6 is higher priority than #5, so pickNext order
  // holds within the set — #6 goes first.
  const ready = [
    { number: 5, createdAt: "2026-01-01", labels: [{ name: "priority:low" }] },
    { number: 6, createdAt: "2026-01-02", labels: [{ name: "priority:high" }] },
  ];
  const ordered = await dispatchOne({ config: mkConfig(), ready, targets: [5, 6], statePath: "o.json", dryRun: true, log: () => {} });
  assert.equal(ordered.plan.issue, 6, "within the set, pickNext ordering (priority then age) is preserved");

  // One worker per poll pass: a single dispatchOne call dispatches at most one.
  let spawns = 0;
  const one = await dispatchOne({
    config: mkConfig(),
    ready: [{ number: 5, labels: [] }, { number: 6, labels: [] }],
    targets: [5, 6],
    statePath: "one.json",
    spawn: () => (spawns++, 4242),
    gh: async () => ({ ref: "x" }),
    isAlive: () => false,
    kill: () => {},
    now: () => 0,
    sleep: () => Promise.resolve(),
    log: () => {},
  });
  assert.equal(spawns, 1, "exactly one worker is spawned per poll pass");
  // Both unlabeled -> pickNext ties break on issue number, so #5 (lowest) is the top.
  assert.equal(one.dispatched, 5, "the single dispatch is the top of the targeted queue");

  // maxWorkers respected: at capacity, a targeted pass dispatches nothing.
  writeFileSync("cap.json", JSON.stringify({ 6: { pid: 100, status: "dispatched" } }));
  const capped = await dispatchOne({
    config: mkConfig({ maxWorkers: 1 }),
    ready: [{ number: 5, labels: [] }],
    targets: [5],
    statePath: "cap.json",
    spawn: () => 1,
    isAlive: () => true,
    log: () => {},
  });
  assert.equal(capped.reason, "at-capacity", "targeting still respects maxWorkers — no dispatch at capacity");
});

// Criterion 4: `--dry-run` combined with `--issues` prints the per-issue plan
// and spawns nothing.
await inTempDir(async () => {
  let spawns = 0;
  const logs = [];
  const r = await dispatchOne({
    config: mkConfig(),
    ready: [{ number: 7, labels: [] }, { number: 8, labels: [] }],
    targets: [8],
    statePath: "s.json",
    dryRun: true,
    spawn: () => (spawns++, 1),
    log: (m) => logs.push(m),
  });
  assert.equal(r.dryRun, true, "dry-run returns a plan, not a dispatch");
  assert.equal(r.plan.issue, 8, "the plan names the targeted issue");
  assert.equal(spawns, 0, "dry-run with --issues spawns nothing");
  assert.ok(!existsSync("s.json"), "dry-run writes no state");
  assert.match(logs.join("\n"), /issue #8/, "the per-issue plan is printed");
});

// Test note: a target set dispatches one worker per pass regardless of how many
// issues it names — the dispatch treats the set as a plain queue (deduplication
// itself is a parse concern, covered in herd.test.mjs), so pickNext still yields
// exactly one worker per pass.
await inTempDir(async () => {
  let spawns = 0;
  const r = await dispatchOne({
    config: mkConfig(),
    ready: [{ number: 12, labels: [] }, { number: 34, labels: [] }],
    targets: [12, 34],
    statePath: "s.json",
    spawn: () => (spawns++, 99),
    gh: async () => ({ ref: "x" }),
    isAlive: () => false,
    kill: () => {},
    now: () => 0,
    sleep: () => Promise.resolve(),
    log: () => {},
  });
  assert.equal(spawns, 1, "a target set dispatches one worker per pass, not one per named issue");
  assert.equal(readState("s.json")[String(r.dispatched)].status, "dispatched", "the dispatched issue is recorded once");
});

// Test note: `--issues` with `--max 5` runs up to five live workers; without
// `--max` the config `maxWorkers` cap holds. Targeting never alters the cap —
// dispatchOne enforces whatever maxWorkers it is handed (herd.mjs passes the
// `--max` override or the config default), independent of the target set.
await inTempDir(async () => {
  // maxWorkers 5 (as an explicit --max override would supply): a fifth targeted
  // dispatch proceeds when four workers are live.
  const four = { 1: { pid: 11, status: "dispatched" }, 2: { pid: 12, status: "dispatched" }, 3: { pid: 13, status: "dispatched" }, 4: { pid: 14, status: "dispatched" } };
  writeFileSync("hi.json", JSON.stringify(four));
  const r5 = await dispatchOne({
    config: mkConfig(), ready: [{ number: 9, labels: [] }], targets: [9], statePath: "hi.json", maxWorkers: 5,
    spawn: () => 900, gh: async () => ({ ref: "x" }), isAlive: () => true, kill: () => {}, now: () => 0, sleep: () => Promise.resolve(), log: () => {},
  });
  assert.equal(r5.dispatched, 9, "a fifth worker dispatches under --max 5");
  // Without --max, the config default (3) caps: three live workers -> no dispatch.
  const three = { 1: { pid: 11, status: "dispatched" }, 2: { pid: 12, status: "dispatched" }, 3: { pid: 13, status: "dispatched" } };
  writeFileSync("lo.json", JSON.stringify(three));
  const capped = await dispatchOne({
    config: mkConfig(), ready: [{ number: 9, labels: [] }], targets: [9], statePath: "lo.json",
    spawn: () => 1, isAlive: () => true, log: () => {},
  });
  assert.equal(capped.reason, "at-capacity", "without --max the config maxWorkers (3) cap holds under targeting");
});

// ── issue #419 (plan 0173): event-driven local dispatch. The supervisor reacts
// to local worker events instead of waiting for the poll tick. One test per
// acceptance criterion, named after it. ──

// #419 criterion 1: a worker exit immediately triggers the monitor/reconcile
// pass for that issue and, when capacity and eligible targets remain, the next
// dispatch — from the exit event alone, without waiting for a tick.
await inTempDir(async () => {
  const calls = [];
  // The reactive pass the supervisor runs on a worker exit: pollOnce (heartbeat)
  // only on a tick, monitor + drain-dispatch on every pass.
  const runPass = (kind) =>
    supervisorStep({
      kind, gh: async () => [], config: mkConfig(), maxWorkers: 3,
      statePath: "s.json", escalationsPath: "e.md", eventsPath: "ev.jsonl",
      pollOnce: async () => calls.push("heartbeat"),
      monitorOnce: async () => calls.push("monitor"),
      surveyReady: async () => [],
      dispatchOne: async () => (calls.push("dispatch"), { dispatched: null, reason: "no-eligible-issue" }),
      log: () => {},
    });
  const pump = createSupervisorPump({ runPass });
  // A worker's process exit fires notifyExit; the supervisor wires that to an
  // immediate reactive (event) pass.
  writeFileSync("s.json", "{}");
  let onExitCb;
  const spawn = (argv, env, logFile, cb) => ((onExitCb = cb), 4242);
  const ready = [{ number: 5, createdAt: "2026-01-01", labels: [{ name: "priority:medium" }] }];
  await dispatchOne({
    config: mkConfig(), ready, statePath: "s.json", escalationsPath: "e.md", eventsPath: "ev.jsonl",
    gh: async (a) => (a[0] === "api" ? {} : []), spawn, isAlive: () => true, onPath: () => true,
    now: () => NOW, sleep: async () => {}, log: () => {}, notifyExit: () => pump.event(),
  });
  assert.ok(onExitCb, "the dispatched worker's exit handler is wired");
  calls.length = 0; // watch only the reaction, not the dispatch that spawned it
  onExitCb(0, null); // the worker process exits
  await pump.idle();
  assert.ok(calls.includes("monitor"), "a worker exit triggers the monitor/reconcile pass from the exit event alone");
  assert.ok(calls.includes("dispatch"), "and the next dispatch, without waiting for the tick");
  assert.ok(!calls.includes("heartbeat"), "the exit-driven pass runs no pollOnce/heartbeat (it is an event pass)");
});

// Shared offline harness for the drain checks below: claim ref always present,
// spawn/liveness/adapter-availability all stubbed so dispatchOne drains for real.
const readyList = (...ns) => ns.map((n) => ({ number: n, createdAt: "2026-01-01", labels: [{ name: "priority:medium" }] }));
const stepBase = { gh: async (a) => (a[0] === "api" ? {} : []), statePath: "s.json", escalationsPath: "e.md", eventsPath: "ev.jsonl", isAlive: () => true, onPath: () => true, now: () => NOW, sleep: async () => {}, log: () => {} };

// #419 criterion 2: with 3 scoped targets and maxWorkers 3, all three workers
// launch in a single drained pass as each preceding claim is observed, not one
// per tick.
await inTempDir(async () => {
  let pid = 100;
  const r = await supervisorStep({ ...stepBase, kind: "tick", config: mkConfig({ maxWorkers: 3 }), maxWorkers: 3, surveyReady: async () => readyList(1, 2, 3), spawn: () => ++pid });
  assert.equal(r.launched, 3, "all three workers launch in one pass, not one per tick");
  assert.deepEqual(Object.keys(readState("s.json")).sort(), ["1", "2", "3"], "each of the three targets has a worker after the single pass");
});

// #419 criterion 3: an event-driven dispatch attempt while at maxWorkers, or for
// an issue that already has a worker, launches nothing.
await inTempDir(async () => {
  writeFileSync("s.json", JSON.stringify({
    7: { adapter: "claude", pid: 111, logFile: "a.log", attempts: 1, pr: null, status: "dispatched" },
    8: { adapter: "claude", pid: 112, logFile: "b.log", attempts: 1, pr: null, status: "dispatched" },
  }));
  let spawns = 0;
  const r = await supervisorStep({ ...stepBase, kind: "event", config: mkConfig({ maxWorkers: 2 }), maxWorkers: 2, surveyReady: async () => readyList(7, 8, 9), spawn: () => (spawns++, 999) });
  assert.equal(spawns, 0, "an event-driven dispatch at maxWorkers spawns nothing");
  assert.equal(r.launched, 0, "no worker is launched");
  assert.deepEqual(Object.keys(readState("s.json")).sort(), ["7", "8"], "issue #9 is held at capacity and the already-tracked #7/#8 get no second worker");
});

console.log("PASS herd-dispatch.test.mjs (8 checks for #105/#126 + 3 for #127 + 1 for #138 + 1 for #151 + 1 for #156 + 3 for #285 + 4 for #286 + 5 for #350 dispatch filter + 3 for #419 event-driven dispatch)");
