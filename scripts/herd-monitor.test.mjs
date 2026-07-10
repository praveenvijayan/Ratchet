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
import { readState } from "./herd-survey.mjs";

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

// Criterion 4: once attempts reaches reworkCap, the issue is escalated and never
// retried again.
await inTempDir(async () => {
  writeStateFile("s.json", { 8: { adapter: "claude", pid: 444, logFile: "logs/issue-8.log", attempts: 2, status: "dispatched", pr: null, exitCode: 1 } });
  const logs = [];
  const common = { statePath: "s.json", escalationsPath: "esc.md", gh: async () => [], isAlive: () => false, now: () => NOW };
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
    gh: async () => [{ number: 50, headRefName: "agent/issue-1" }], isAlive: () => false, spawn: () => 6000, now: () => NOW, log: (m) => logs.push(m),
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

console.log("PASS herd-monitor.test.mjs (5 criteria + #169: 1 + exit-capture seam)");
