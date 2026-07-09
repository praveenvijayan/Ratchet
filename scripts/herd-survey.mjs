#!/usr/bin/env node
// herd-survey.mjs — the ratchet-herd supervisor's spine: a poll loop that
// surveys reality via `gh`, a state file rebuilt from reality (never trusted
// blindly), and the escalation channel later stages append to. This slice only
// observes and reconciles — it never dispatches, and it NEVER merges, approves,
// closes, or labels a PR or issue. When reality contradicts the state file, the
// supervisor escalates for a human rather than improvising.
//
// State file (.ratchet/herd-state.json): issue -> { adapter, pid, logFile,
// attempts, status, pr }. On each poll it is reconciled against `gh` and
// process liveness, so a stale pid or a concluded PR can never masquerade as a
// live worker. Every outside-world call is injectable, so the whole loop is
// exercised offline with no network and no spawned CLIs. Zero dependencies.

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const STATE_FILE = ".ratchet/herd-state.json";
export const ESCALATIONS_FILE = ".ratchet/herd-escalations.md";
export const EVENTS_FILE = ".ratchet/events.jsonl";
export const HERD_EVENT_TYPES = Object.freeze([
  "dispatch",
  "resume",
  "rework",
  "claim-detected",
  "pr-detected",
  "worker-exit",
  "worker-kill",
  "escalation",
]);

const pexec = promisify(execFile);

// Default gh caller: run `gh <args>` and parse its JSON stdout. Injected in
// tests so the survey runs with no network.
export async function ghJson(args) {
  const { stdout } = await pexec("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// Is this pid a live process? A signal-0 probe: no such process -> not alive;
// EPERM means it exists but we don't own it (still alive). A bad pid is dead.
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Survey the world in one pass: the ready queue, the in-progress issues, and
// every open PR. `gh` is injected; returns already-parsed arrays.
export async function surveyReality(gh) {
  const [ready, inProgress, openPrs] = await Promise.all([
    gh(["issue", "list", "--state", "open", "--label", "state:ready", "--json", "number,title", "--limit", "200"]),
    gh(["issue", "list", "--state", "open", "--label", "state:in-progress", "--json", "number,title", "--limit", "200"]),
    gh(["pr", "list", "--state", "open", "--json", "number,headRefName", "--limit", "200"]),
  ]);
  return { ready, inProgress, openPrs };
}

// Read the state file, tolerating a missing or corrupt file by returning {} —
// the supervisor then rebuilds from reality rather than crashing.
export function readState(path = STATE_FILE) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

export function formatHerdEvent({ now = Date.now(), event, issue, adapter, pid, logFile, attempts, pr, status }) {
  if (!HERD_EVENT_TYPES.includes(event)) throw new Error(`unknown herd event type: ${event}`);
  const line = { ts: new Date(now).toISOString(), event, issue: Number(issue) };
  for (const [key, value] of Object.entries({ adapter, pid, logFile, attempts, pr, status })) {
    if (value !== undefined) line[key] = value;
  }
  return line;
}

export function appendHerdEvent(path = EVENTS_FILE, entry, warn = console.warn) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(formatHerdEvent(entry)) + "\n");
    return true;
  } catch (e) {
    warn(`herd: warning: failed to append event to ${path}: ${e.message}`);
    return false;
  }
}

// Reconcile the state file against reality instead of trusting it: an entry
// whose tracked PR is no longer open (merged or closed), or whose worker pid is
// no longer alive, is cleared and flagged. Returns the reconciled state plus
// the list of changes (each an escalation candidate).
export function reconcileState(state, reality, isAlive) {
  const openPrs = reality.openPrNumbers instanceof Set
    ? reality.openPrNumbers
    : new Set((reality.openPrNumbers || []).map(Number));
  const next = {};
  const changes = [];
  for (const [issue, entry] of Object.entries(state || {})) {
    const e = { ...entry };
    if (e.pr != null && !openPrs.has(Number(e.pr))) {
      changes.push({
        issue,
        what: `tracked PR #${e.pr} is no longer open (merged or closed)`,
        adapter: e.adapter,
        pid: e.pid,
        logFile: e.logFile || null,
        attempts: e.attempts,
        pr: e.pr,
        status: "pr-concluded",
      });
      e.status = "pr-concluded";
      e.pid = null;
    } else if (e.pid != null && !isAlive(e.pid)) {
      changes.push({
        issue,
        what: `worker pid ${e.pid} is not alive`,
        adapter: e.adapter,
        pid: e.pid,
        logFile: e.logFile || null,
        attempts: e.attempts,
        pr: e.pr,
        status: "dead",
      });
      e.status = "dead";
      e.pid = null;
    }
    next[issue] = e;
  }
  return { state: next, changes };
}

// A human-readable escalation block: timestamp, issue, what happened, the log
// file to inspect, and a suggested next action. Kept factual — the supervisor
// escalates; the human decides.
export function formatEscalation({ now, issue, what, logFile, action }) {
  const ts = new Date(now).toISOString();
  return [
    `## ${ts} — issue #${issue}`,
    `- What happened: ${what}`,
    `- Log file: ${logFile || "(none)"}`,
    `- Suggested action: ${action || "review the log and re-queue the issue if its work is unfinished"}`,
    "",
  ].join("\n");
}

export function appendEscalation(path, entry, { eventsPath = EVENTS_FILE, warn = console.warn } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, formatEscalation(entry) + "\n");
  appendHerdEvent(
    eventsPath,
    {
      now: entry.now,
      event: "escalation",
      issue: entry.issue,
      adapter: entry.adapter,
      pid: entry.pid,
      logFile: entry.logFile,
      attempts: entry.attempts,
      pr: entry.pr,
      status: entry.status,
    },
    warn,
  );
}

// One supervisor pass: survey, reconcile the state file, escalate anomalies,
// prune the concluded/dead entries those escalations describe (so a re-queued
// issue is no longer skipped forever), report a one-line summary, and point at
// /ratchet-status when the fleet is idle. A failed `gh` call logs one line and
// returns { ok: false } so the loop retries next poll instead of crashing.
// Injectable deps keep it fully offline in tests.
export async function pollOnce({
  gh,
  isAlive = isPidAlive,
  now,
  statePath = STATE_FILE,
  escalationsPath = ESCALATIONS_FILE,
  eventsPath = EVENTS_FILE,
  log = console.log,
}) {
  let reality;
  try {
    reality = await surveyReality(gh);
  } catch (e) {
    log(`herd: gh survey failed: ${e.message}; retrying next poll.`);
    return { ok: false };
  }

  const openPrNumbers = new Set(reality.openPrs.map((p) => Number(p.number)));
  const { state, changes } = reconcileState(readState(statePath), { openPrNumbers }, isAlive);

  const stamp = now ?? Date.now();
  for (const c of changes) {
    appendEscalation(escalationsPath, {
      now: stamp,
      issue: c.issue,
      what: c.what,
      adapter: c.adapter,
      pid: c.pid,
      logFile: c.logFile,
      attempts: c.attempts,
      pr: c.pr,
      status: c.status,
      action: "reconciled on startup — review the log and re-queue the issue if its work is unfinished",
    }, { eventsPath, warn: log });
  }

  // Prune each reconciled entry only after its escalation is written. A stale
  // entry left in the state file makes dispatchOne skip that issue forever, so a
  // re-queued issue could never be picked up again. Remove an entry only when
  // its worker is gone (pid cleared or dead) AND it tracks no open PR — a live
  // worker or an open PR is always retained, no matter what was flagged.
  let pruned = 0;
  for (const c of changes) {
    const e = state[c.issue];
    if (!e) continue;
    const workerGone = e.pid == null || !isAlive(e.pid);
    const prConcluded = e.pr == null || !openPrNumbers.has(Number(e.pr));
    if (workerGone && prConcluded) {
      delete state[c.issue];
      pruned += 1;
    }
  }
  writeState(statePath, state);

  const liveWorkers = Object.values(state).filter((e) => e.pid != null && isAlive(e.pid)).length;
  const idle = reality.ready.length === 0 && liveWorkers === 0;
  log(
    `herd: poll — ${reality.ready.length} ready, ${reality.inProgress.length} in-progress, ` +
      `${openPrNumbers.size} open PRs, ${liveWorkers} live workers, ` +
      `${pruned} concluded ${pruned === 1 ? "entry" : "entries"} pruned.`,
  );
  if (idle) {
    log(
      "herd: no state:ready issues and no live workers. Run /ratchet-status to diagnose the " +
        "queue (drafts missing criteria, blocked chains, or an unmerged planning PR).",
    );
  }

  return {
    ok: true,
    ready: reality.ready.length,
    inProgress: reality.inProgress.length,
    openPrs: openPrNumbers.size,
    reconciled: changes.length,
    pruned,
    liveWorkers,
    idle,
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The poll loop. `--once` (once: true) runs a single pass and returns; the
// default keeps polling every pollSeconds. `step` is the per-pass work
// (defaulting to pollOnce; the dispatcher composes survey + dispatch into it),
// and `sleep` is injectable so tests can bound the otherwise-infinite loop.
export async function runLoop(opts) {
  const { once = false, pollSeconds = 60, sleep = defaultSleep, step = pollOnce } = opts;
  for (;;) {
    await step(opts);
    if (once) return;
    await sleep(pollSeconds * 1000);
  }
}
