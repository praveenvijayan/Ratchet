#!/usr/bin/env node
// herd-monitor.test.mjs — the criteria are the test plan. One test per
// acceptance criterion of issue #106 (monitor herd workers, resume crashes,
// escalate blocked exits), through herd-monitor.mjs's public interface. Offline:
// gh, spawn, liveness, and the clock are injected; the seam test drives a real
// detached spawn against a stub CLI to prove the exit-capture (spawnWorker's
// onExit -> recordExit) the monitor's exit-0-vs-crash split depends on.
// Zero dependencies. Run:  node scripts/herd-monitor.test.mjs

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorOnce } from "./herd-monitor.mjs";
import { spawnWorker, recordExit } from "./herd-dispatch.mjs";
import { readState, deleteRefCommand, requeueCommand } from "./herd-survey.mjs";
import { fileURLToPath } from "node:url";

const NOW = Date.UTC(2026, 6, 9, 12, 0, 0);
const noSpawn = (msg) => () => {
  throw new Error(msg);
};
const writeStateFile = (path, state) => writeFileSync(path, JSON.stringify(state) + "\n");

const mkConfig = (over = {}) => ({
  maxWorkers: 3,
  pollSeconds: 60,
  reworkCap: 2,
  logDir: "logs",
  adapters: { claude: { launch: ["claude", "-p", "{prompt}"], resume: ["claude", "--resume", "{issue}"], promptTemplate: "issue {issue}", env: {} } },
  routing: { default: "claude", labels: {} },
  ...over,
});

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-monitor-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    return await fn(dir);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function until(pred, attempts = 80, ms = 25) {
  for (let i = 0; i < attempts; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error("condition not met in time");
}

// Criterion 1: exit 0 with an open PR whose head is agent/issue-<N> marks the
// worker for PR verification (no escalation, no respawn).
await inTempDir(async () => {
  writeStateFile("s.json", { 5: { adapter: "claude", pid: 111, logFile: "logs/issue-5.log", attempts: 1, status: "dispatched", pr: null, exitCode: 0 } });
  const logs = [];
  const r = await monitorOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: async () => [{ number: 42, headRefName: "agent/issue-5" }],
    isAlive: () => false, spawn: noSpawn("must not respawn a worker headed for verification"), now: () => NOW, log: (m) => logs.push(m),
  });
  const s = readState("s.json")["5"];
  assert.equal(s.status, "awaiting-verification", "exit 0 + open PR -> awaiting-verification");
  assert.equal(s.pr, 42, "the discovered PR number is recorded");
  assert.equal(s.pid, null, "the worker pid is cleared");
  assert.ok(!existsSync("esc.md"), "verification is not an escalation");
  assert.ok(logs.some((m) => /#5/.test(m) && /verify/.test(m) && /PR #42/.test(m)), "one status line names the verify transition");
  assert.equal(r.transitions.length, 1);
});

// Criterion 2: exit 0 with no PR escalates with the log tail quoted, so the
// agent's own report reaches the human.
await inTempDir(async () => {
  mkdirSync("logs", { recursive: true });
  writeFileSync("logs/issue-6.log", "starting run\nchecked queue\nherd: no state:ready issues — draining\n");
  writeStateFile("s.json", { 6: { adapter: "claude", pid: 222, logFile: "logs/issue-6.log", attempts: 1, status: "dispatched", pr: null, exitCode: 0 } });
  const logs = [];
  await monitorOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: async () => [], isAlive: () => false, spawn: noSpawn("a clean exit with no PR must escalate, not respawn"), now: () => NOW, log: (m) => logs.push(m),
  });
  assert.equal(readState("s.json")["6"].status, "escalated", "exit 0 + no PR -> escalated");
  const esc = readFileSync("esc.md", "utf8");
  assert.match(esc, /exited 0 without opening a PR/, "escalation explains the clean stop");
  assert.match(esc, /herd: no state:ready issues — draining/, "the agent's own log tail is quoted verbatim");
  assert.ok(logs.some((m) => /#6/.test(m) && /escalated/.test(m)), "one status line names the escalation");
});

// Criterion 3: a nonzero exit OR a crash increments attempts and relaunches via
// the adapter's resume command (or launch when no resume is configured).
await inTempDir(async () => {
  // crash (pid dead, no recorded exit code) -> resume via the resume command
  writeStateFile("s.json", { 7: { adapter: "claude", pid: 333, logFile: "logs/issue-7.log", attempts: 1, status: "dispatched", pr: null } });
  const spawned = [];
  await monitorOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md", gh: async () => [], isAlive: () => false,
    spawn: (argv, env, logFile) => (spawned.push({ argv, logFile }), 7777), now: () => NOW, log: () => {},
  });
  const s = readState("s.json")["7"];
  assert.equal(s.attempts, 2, "a crash increments attempts");
  assert.equal(s.status, "resumed", "the worker is relaunched");
  assert.equal(s.pid, 7777, "the new pid replaces the dead one");
  assert.equal(s.exitCode, undefined, "a stale exit code is cleared so it can't reclassify the new run");
  assert.deepEqual(spawned[0].argv, ["claude", "--resume", "7"], "relaunch uses the resume command with {issue} substituted");
  assert.equal(spawned[0].logFile, "logs/issue-7.log", "the resume appends to the same log");

  // nonzero exit with no resume configured -> relaunch via launch
  writeStateFile("s2.json", { 9: { adapter: "claude", pid: 999, logFile: "logs/issue-9.log", attempts: 1, status: "dispatched", pr: null, exitCode: 1 } });
  const config = mkConfig();
  delete config.adapters.claude.resume;
  const spawned2 = [];
  await monitorOnce({ config, statePath: "s2.json", escalationsPath: "esc.md", gh: async () => [], isAlive: () => false, spawn: (argv) => (spawned2.push(argv), 8888), now: () => NOW, log: () => {} });
  assert.equal(readState("s2.json")["9"].status, "resumed", "a nonzero exit also relaunches");
  assert.deepEqual(spawned2[0], ["claude", "-p", "issue 9"], "relaunch falls back to launch when no resume is configured");
});

// Criterion 4: once attempts reaches reworkCap with no recoverable claim ref,
// the issue is escalated and never retried again. (When a ref IS present the
// supervisor auto-recovers instead — see herd-claim recovery, issue #427; here
// the ref-api probe throws, so the ref reads absent and the capped worker
// escalates exactly as before.)
await inTempDir(async () => {
  writeStateFile("s.json", { 8: { adapter: "claude", pid: 444, logFile: "logs/issue-8.log", attempts: 2, status: "dispatched", pr: null, exitCode: 1 } });
  const logs = [];
  const ghNoRef = async (args) => {
    if (args[0] === "api") throw new Error("404 (ref absent)");
    return [];
  };
  const common = { statePath: "s.json", escalationsPath: "esc.md", gh: ghNoRef, isAlive: () => false, now: () => NOW };
  await monitorOnce({ ...common, config: mkConfig({ reworkCap: 2 }), spawn: noSpawn("a capped worker must never be retried"), log: (m) => logs.push(m) });
  assert.equal(readState("s.json")["8"].status, "escalated", "reaching reworkCap escalates");
  assert.match(readFileSync("esc.md", "utf8"), /rework cap \(2 attempts\)/, "the escalation names the exhausted retry budget");
  assert.ok(logs.some((m) => /#8/.test(m) && /reworkCap 2/.test(m)), "one status line names the cap");
  // A second pass must not touch the now-terminal worker.
  const logs2 = [];
  await monitorOnce({ ...common, config: mkConfig(), spawn: noSpawn("terminal workers are never touched again"), log: (m) => logs2.push(m) });
  assert.equal(logs2.length, 0, "an escalated worker produces no further transitions");
});

// Criterion 5: every worker state change prints exactly one compact (single-
// line) status line to stdout — operator visibility with zero multiplexer.
await inTempDir(async () => {
  writeStateFile("s.json", {
    1: { adapter: "claude", pid: 11, logFile: "logs/1.log", attempts: 1, status: "dispatched", pr: null, exitCode: 0 }, // verify
    2: { adapter: "claude", pid: 12, logFile: "logs/2.log", attempts: 1, status: "dispatched", pr: null }, // retry
    3: { adapter: "claude", pid: 13, logFile: "logs/3.log", attempts: 2, status: "dispatched", pr: null, exitCode: 1 }, // capped
    4: { adapter: "claude", pid: 14, logFile: "logs/4.log", attempts: 1, status: "awaiting-verification", pr: 7 }, // terminal — no change
  });
  const logs = [];
  const r = await monitorOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "esc.md",
    gh: async (args) => {
      if (args[0] === "api") throw new Error("404 (ref absent)"); // issue 3's capped worker escalates, not auto-recovers
      return [{ number: 50, headRefName: "agent/issue-1" }];
    }, isAlive: () => false, spawn: () => 6000, now: () => NOW, log: (m) => logs.push(m),
  });
  assert.equal(logs.length, 3, "one line per state change — the terminal worker prints nothing");
  assert.equal(r.transitions.length, 3, "three workers transitioned");
  for (const line of logs) {
    assert.ok(!line.includes("\n"), "each status line is compact (single line)");
    assert.match(line, /herd: issue #\d+ ->/, "each line names the issue and its transition");
  }
});

// Seam: spawnWorker's onExit fires and recordExit captures the exit code, so the
// monitor can tell a clean exit (criterion 2) from a crash (criterion 3) in
// production — not just from hand-written fixtures.
await inTempDir(async () => {
  writeFileSync("exit0.sh", "exit 0\n");
  writeStateFile("s.json", { 5: { adapter: "claude", pid: null, logFile: "logs/issue-5.log", attempts: 1, status: "dispatched" } });
  spawnWorker(["sh", join(process.cwd(), "exit0.sh")], {}, "logs/issue-5.log", (code, signal) => recordExit("s.json", 5, code, signal));
  await until(() => readState("s.json")["5"].exitCode === 0);
  assert.equal(readState("s.json")["5"].pid, null, "recordExit clears the pid on exit");

  writeFileSync("exit3.sh", "exit 3\n");
  writeStateFile("s2.json", { 6: { adapter: "claude", pid: null, logFile: "logs/issue-6.log", attempts: 1, status: "dispatched" } });
  spawnWorker(["sh", join(process.cwd(), "exit3.sh")], {}, "logs/issue-6.log", (code, signal) => recordExit("s2.json", 6, code, signal));
  await until(() => readState("s2.json")["6"].exitCode === 3);
});

// --- Issue #169: stop the survey/monitor ping-pong that re-escalates stale
// claims every poll. The monitor side of the fix. ---

// #169 AC1) A state entry with status "stale-claim" is never classified by the
// monitor as a dead or failed worker and never produces a monitor escalation:
// the survey-owned sentinel (pid/adapter null) is skipped, untouched, so it can
// never be resumed-then-escalated (which flipped its status and let the survey
// re-escalate it every poll).
await inTempDir(async () => {
  const sentinel = { adapter: null, pid: null, logFile: null, attempts: 0, status: "stale-claim", pr: null };
  writeStateFile("s.json", { 175: { ...sentinel } });
  const r = await monitorOnce({
    config: mkConfig(), statePath: "s.json", escalationsPath: "e.md", eventsPath: "ev.jsonl",
    gh: async () => [], isAlive: () => false,
    spawn: noSpawn("the monitor must never resume a stale-claim sentinel"),
    now: () => NOW, log: () => {},
  });
  assert.equal(existsSync("e.md"), false, "the monitor writes no escalation for a stale-claim sentinel");
  assert.deepEqual(r.transitions, [], "the stale-claim sentinel produces no monitor transition");
  assert.deepEqual(readState("s.json")["175"], sentinel, "the sentinel entry is left exactly as the survey wrote it");
});

// ── Issue #427: the supervisor auto-recovers a claim ref left by its own dead
// worker (plan 0178-herd-dead-worker-claim-autorecovery). Criterion 3 (an
// unobserved/foreign ref still only escalates) is tested in herd-survey.test.mjs
// where the survey's stale-claim path lives; the other criteria are exercised
// here through monitorOnce, all offline (gh injected). ──

// A gh stub for the recovery path: the claim ref resolves (present), delete /
// comment / label-edit all succeed, and `pr list` returns no open PR. Every call
// is recorded so a test can prove exactly which gh operations recovery issued.
const mkRecoveryGh = (issue, { deleteThrows = false, requeueThrows = false, openPr = null } = {}) => {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return openPr ? [{ number: openPr, headRefName: `agent/issue-${issue}` }] : [];
    if (args[0] === "api" && args[1] === "-X" && args[2] === "DELETE") {
      if (deleteThrows) throw new Error("ref delete 403");
      return {};
    }
    if (args[0] === "api") return { ref: `refs/heads/agent/issue-${issue}` }; // ref present
    if (args[0] === "issue" && (args[1] === "comment" || args[1] === "edit")) {
      if (requeueThrows) throw new Error("requeue 500");
      return {};
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  gh.calls = calls;
  return gh;
};
const cappedEntry = (over = {}) => ({ adapter: "claude", pid: 444, logFile: "logs/issue.log", attempts: 2, status: "dispatched", pr: null, exitCode: 1, ...over });

// --- Criterion 1 (#427): a supervisor-spawned worker that dies at the rework cap
// with no PR and its observed claim ref still on origin -> the supervisor deletes
// that ref and requeues the issue (label flip + ratchet-requeue comment), logging
// exactly one recovery event and NO escalation. -------------------------------
await inTempDir(async () => {
  writeStateFile("s.json", { 30: cappedEntry() });
  const gh = mkRecoveryGh(30);
  const logs = [];
  const r = await monitorOnce({
    config: mkConfig({ reworkCap: 2 }), statePath: "s.json", escalationsPath: "esc.md", eventsPath: "ev.jsonl",
    gh, isAlive: () => false, spawn: noSpawn("recovery must not respawn the worker"), now: () => NOW, log: (m) => logs.push(m),
  });
  assert.ok(gh.calls.some((a) => a[0] === "api" && a[1] === "-X" && a[2] === "DELETE" && a[3].endsWith("agent/issue-30")), "the observed claim ref is deleted on origin");
  assert.ok(gh.calls.some((a) => a[0] === "issue" && a[1] === "comment" && a[4].includes("auto-recovery")), "a requeue comment explaining the recovery is posted");
  assert.ok(gh.calls.some((a) => a[0] === "issue" && a[1] === "edit" && a.includes("state:ready") && a.includes("state:in-progress")), "the issue is flipped to state:ready (requeued)");
  assert.equal(readState("s.json")["30"], undefined, "the recovered issue is cleared from state");
  assert.equal(existsSync("esc.md"), false, "recovery is not an escalation");
  const events = readFileSync("ev.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.event === "claim-recovered").length, 1, "exactly one recovery event is logged");
  assert.equal(r.transitions.filter((t) => t.action === "recovered").length, 1, "exactly one 'recovered' transition");
  assert.ok(logs.some((m) => /#30/.test(m) && /recovered/.test(m)), "one status line names the recovery");
});

// --- Criterion 2 (#427): the recovered issue is redispatchable in the same run —
// it is gone from the state file (so dispatch's one-worker-per-issue guard no
// longer skips it) AND its label is back to state:ready (so the ready survey
// lists it again). Together those are exactly what lets a scoped run continue to
// completion without a human. -------------------------------------------------
await inTempDir(async () => {
  writeStateFile("s.json", { 31: cappedEntry() });
  const gh = mkRecoveryGh(31);
  await monitorOnce({
    config: mkConfig({ reworkCap: 2 }), statePath: "s.json", escalationsPath: "esc.md", eventsPath: "ev.jsonl",
    gh, isAlive: () => false, spawn: noSpawn("no respawn"), now: () => NOW, log: () => {},
  });
  assert.ok(!("31" in readState("s.json")), "no state entry blocks re-dispatch of the recovered issue");
  const editCall = gh.calls.find((a) => a[0] === "issue" && a[1] === "edit");
  assert.ok(editCall && editCall.includes("state:ready"), "the issue is labelled state:ready so the ready survey re-lists it");
});

// --- Criterion 4 (#427): a dead worker whose claim ref has an open PR is never
// touched by recovery — PR precedence routes it to verification (the orphaned-PR
// adoption path), so no ref is deleted and no requeue happens. -----------------
await inTempDir(async () => {
  writeStateFile("s.json", { 32: cappedEntry() });
  const gh = mkRecoveryGh(32, { openPr: 77 });
  const r = await monitorOnce({
    config: mkConfig({ reworkCap: 2 }), statePath: "s.json", escalationsPath: "esc.md", eventsPath: "ev.jsonl",
    gh, isAlive: () => false, spawn: noSpawn("no respawn"), now: () => NOW, log: () => {},
  });
  assert.equal(readState("s.json")["32"].status, "awaiting-verification", "an open PR routes the dead worker to verification, not recovery");
  assert.equal(readState("s.json")["32"].pr, 77, "the discovered PR is adopted");
  assert.ok(!gh.calls.some((a) => a[0] === "api" && a[2] === "DELETE"), "recovery never deletes a ref backing an open PR");
  assert.equal(r.transitions[0].action, "verify", "the transition is verify, not recovered");
});

// --- Criterion 5 (#427): a gh failure during ref deletion OR requeue produces a
// single escalation carrying the exact recovery commands, does not crash the
// supervisor, and does not stall the rest of the pass (a second worker is still
// processed). ------------------------------------------------------------------
await inTempDir(async () => {
  // Two workers in one pass: #40 recovers but its ref-delete fails; #41 is a
  // healthy crash that must still be resumed in the same pass.
  writeStateFile("s.json", { 40: cappedEntry(), 41: { adapter: "claude", pid: 555, logFile: "logs/issue-41.log", attempts: 1, status: "dispatched", pr: null } });
  const spawned = [];
  const gh = async (args) => {
    if (args[0] === "pr" && args[1] === "list") return [];
    if (args[0] === "api" && args[2] === "DELETE") throw new Error("ref delete 403"); // recovery fails for #40
    if (args[0] === "api") return { ref: `refs/heads/agent/issue-40` }; // #40 ref present
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const r = await monitorOnce({
    config: mkConfig({ reworkCap: 2 }), statePath: "s.json", escalationsPath: "esc.md", eventsPath: "ev.jsonl",
    gh, isAlive: () => false, spawn: (argv, env, logFile) => (spawned.push(logFile), 9099), now: () => NOW, log: () => {},
  });
  assert.equal(r.ok, true, "the pass completes; a recovery gh failure never crashes the supervisor");
  assert.equal(readState("s.json")["40"].status, "escalated", "a failed recovery falls back to an escalation");
  const esc = readFileSync("esc.md", "utf8");
  assert.ok(esc.includes(deleteRefCommand(40)), "the escalation carries the exact delete-ref command");
  assert.ok(esc.includes(requeueCommand(40)), "the escalation carries the exact requeue command");
  assert.equal((esc.match(/auto-recovery of its claim ref failed/g) || []).length, 1, "exactly one escalation for the failed recovery");
  assert.equal(readState("s.json")["41"].status, "resumed", "the other worker is still processed — the failure never stalls the run");
  assert.equal(spawned.length, 1, "the healthy worker was resumed in the same pass");
});

// --- Criterion 6 (#427): the supervisor-authority wording in AGENTS.md and
// DOCS.md names this one permitted deletion explicitly (and only this one). -----
{
  const root = new URL("../", import.meta.url);
  const agents = readFileSync(fileURLToPath(new URL("AGENTS.md", root)), "utf8");
  const docs = readFileSync(fileURLToPath(new URL("DOCS.md", root)), "utf8");
  assert.match(agents, /may delete a single\s+claim ref `agent\/issue-<N>` it watched its own worker create/, "AGENTS.md names the one permitted deletion");
  assert.match(agents, /never touches a ref it did not observe its own worker create/, "AGENTS.md bounds the deletion to observed refs");
  assert.match(docs, /One permitted deletion \(dead-worker claim auto-recovery\)/, "DOCS.md supervisor invariants name the permitted deletion");
  assert.match(docs, /never deletes a ref it did not observe its\s+own worker create/, "DOCS.md bounds the deletion to observed refs");
}

// --- Criterion 7 (#427): every criterion above has exactly one test named after
// it — counted across this file and herd-survey.test.mjs (which owns criterion 3).
{
  const CRITERIA = 7;
  const here = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const survey = readFileSync(fileURLToPath(new URL("./herd-survey.test.mjs", import.meta.url)), "utf8");
  const markers = [...(here + survey).matchAll(/^\/\/ --- Criterion (\d+) \(#427\):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "no #427 criterion is tested twice");
  assert.equal(markers.length, CRITERIA, `exactly ${CRITERIA} #427 criteria are tested`);
  for (let n = 1; n <= CRITERIA; n++) assert.ok(unique.has(n), `#427 criterion ${n} has a test`);
}

console.log("PASS herd-monitor.test.mjs (5 criteria + #169: 1 + exit-capture seam + #427: 6 criteria)");
