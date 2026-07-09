#!/usr/bin/env node
// herd-dispatch.mjs — the ratchet-herd dispatcher. Picks the top ready issue in
// queue order, routes it to an adapter, spawns a detached worker with its log
// on disk, and serializes the claim window so two workers never race claims in
// the shared clone. One issue -> one worker, ever: the state file is the lock,
// claim-window serialization is the backstop. The supervisor never touches
// worktrees or branches (ratchet-next does) and never merges, approves, closes,
// or labels — a stuck claim escalates rather than improvising.
//
// Every outside-world call (spawn, gh, kill, clock, sleep) is injectable, so
// tests drive stub adapter CLIs offline with no real fleet.
// Zero dependencies. Requires Node 20+.

import { mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { resolveAdapter, substitute } from "./herd.mjs";
import {
  STATE_FILE,
  ESCALATIONS_FILE,
  EVENTS_FILE,
  readState,
  writeState,
  appendEscalation,
  appendHerdEvent,
  isPidAlive,
} from "./herd-survey.mjs";

const PRIORITY_RANK = { "priority:high": 0, "priority:medium": 1, "priority:low": 2 };
const labelNames = (issue) => (issue.labels || []).map((l) => l.name);

// Pick the top issue by priority (high > medium > low) then age (oldest first),
// the same ordering AGENTS.md prescribes. Ties break on issue number for
// determinism. Returns null for an empty list.
export function pickNext(ready) {
  const ranked = [...ready].sort((a, b) => {
    const pa = Math.min(99, ...labelNames(a).map((n) => PRIORITY_RANK[n] ?? 99));
    const pb = Math.min(99, ...labelNames(b).map((n) => PRIORITY_RANK[n] ?? 99));
    if (pa !== pb) return pa - pb;
    const ta = a.createdAt || "";
    const tb = b.createdAt || "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.number - b.number;
  });
  return ranked.length ? ranked[0] : null;
}

// Resolve an issue to its concrete dispatch: the routed adapter, the argv with
// {prompt}/{issue} substituted, the merged env, and the log file path.
export function buildDispatch(config, issue) {
  const { name, adapter } = resolveAdapter(config, labelNames(issue));
  const prompt = substitute(adapter.promptTemplate || "", { issue: issue.number });
  return {
    adapter: name,
    argv: substitute(adapter.launch, { prompt, issue: issue.number }),
    env: adapter.env || {},
    logFile: `${config.logDir}/issue-${issue.number}.log`,
  };
}

// Spawn a detached worker, redirecting stdout+stderr to logFile (creating its
// directory), with `env` merged over the current environment. Returns the pid,
// or `undefined` when the launch command never started (a missing or
// unexecutable binary yields no pid synchronously) — the caller treats that
// null pid as a spawn failure.
// The optional `onExit(code, signal)` fires when the child exits while this
// supervisor is still alive — the monitor uses it (via recordExit) to tell a
// clean exit from a crash. It never re-refs the child, so it can't keep the
// supervisor running.
// A failed spawn also emits `error` asynchronously; with no listener that
// becomes an uncaught exception that kills the supervisor. We always attach one
// so the process survives, and forward it to the optional `onError(err)`.
export function spawnWorker(argv, env, logFile, onExit, onError) {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, ...env },
    });
    child.once("error", (err) => {
      if (typeof onError === "function") onError(err);
    });
    if (typeof onExit === "function") child.once("exit", onExit);
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

// Record a worker's process exit into the state file: its exit code (null for a
// signal-kill / unknown) and signal, and clear the pid. The monitor reads
// exitCode to tell a clean stop (0) from a crash. Fired from the spawn's `exit`
// listener, so it re-reads the file to avoid clobbering a concurrent poll write
// and no-ops if the entry was already reconciled away.
export function recordExit(path, issue, code, signal, { eventsPath = EVENTS_FILE, now = Date.now, warn = console.warn } = {}) {
  const state = readState(path);
  const entry = state[issue];
  if (!entry) return;
  const pid = entry.pid;
  entry.exitCode = code == null ? null : Number(code);
  entry.exitSignal = signal || null;
  entry.pid = null;
  writeState(path, state);
  appendHerdEvent(eventsPath, {
    now: now(),
    event: "worker-exit",
    issue,
    adapter: entry.adapter,
    pid,
    logFile: entry.logFile,
    attempts: entry.attempts,
    pr: entry.pr,
    status: entry.status,
  }, warn);
}

export async function surveyReady(gh) {
  return gh(["issue", "list", "--state", "open", "--label", "state:ready", "--json", "number,createdAt,labels", "--limit", "200"]);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultKill = (pid) => process.kill(pid, "SIGTERM");
const liveWorkers = (state, isAlive) =>
  Object.values(state).filter((e) => e.pid != null && isAlive(e.pid)).length;

// Poll the server for the worker's claim ref (agent/issue-<N>) until it exists
// or the bounded timeout elapses. Per AGENTS.md §2 the atomic claim *is* that
// branch ref — labels only report, and the state:ready flip happens later in
// the worker's run, so waiting on the label SIGTERMs a correctly-claiming
// worker. Any gh failure — a 404 for the not-yet-created ref or a transient
// blip — is treated as "still waiting", so it never counts as a claim and
// never (on its own) as a dispatch failure. Returns { claimed }.
export async function waitForClaim({ gh, issue, timeoutMs, intervalMs = 1000, now = () => Date.now(), sleep = defaultSleep }) {
  const ref = `repos/{owner}/{repo}/git/ref/heads/agent/issue-${issue}`;
  const start = now();
  for (;;) {
    try {
      await gh(["api", ref]);
      return { claimed: true }; // the ref resolves -> the worker claimed the issue
    } catch {
      // ref not created yet (404) or a transient gh error — keep waiting
    }
    if (now() - start >= timeoutMs) return { claimed: false };
    await sleep(intervalMs);
  }
}

// Dispatch at most one worker this pass. Skips issues already in the state file
// (one worker per issue, ever) and refuses to exceed maxWorkers. On --dry-run
// it returns the plan without spawning. After spawning it serializes on the
// claim window; a timeout kills the worker, marks it dispatch-failed, and
// escalates.
export async function dispatchOne(opts) {
  const {
    config,
    ready,
    statePath = STATE_FILE,
    escalationsPath = ESCALATIONS_FILE,
    eventsPath = EVENTS_FILE,
    spawn: spawnFn = spawnWorker,
    gh,
    isAlive = isPidAlive,
    now = () => Date.now(),
    sleep = defaultSleep,
    log = console.log,
    kill = defaultKill,
    dryRun = false,
    maxWorkers = config.maxWorkers,
    claimTimeoutMs = (config.claimTimeoutSeconds ?? 300) * 1000,
    claimIntervalMs = 1000,
  } = opts;

  const state = readState(statePath);
  const issue = pickNext((ready || []).filter((i) => !(String(i.number) in state)));
  if (!issue) return { dispatched: null, reason: "no-eligible-issue" };

  const plan = buildDispatch(config, issue);
  if (dryRun) {
    log(`herd dry-run: issue #${issue.number} -> ${plan.adapter}: ${plan.argv.join(" ")}`);
    return { dispatched: null, dryRun: true, plan: { issue: issue.number, adapter: plan.adapter, command: plan.argv } };
  }

  const live = liveWorkers(state, isAlive);
  if (live >= maxWorkers) return { dispatched: null, reason: "at-capacity", live, maxWorkers };

  const onExit = (code, signal) => recordExit(statePath, issue.number, code, signal, { eventsPath, now, warn: log });
  const pid = spawnFn(plan.argv, plan.env, plan.logFile, onExit);

  // A missing or unexecutable adapter binary never starts, so spawn returns no
  // pid. Don't crash the supervisor and don't enter the claim wait for a worker
  // that isn't there: record the issue as dispatch-failed with its pid cleared,
  // then escalate with enough to fix it — the adapter, the command, the log.
  if (pid == null) {
    state[issue.number] = { adapter: plan.adapter, pid: null, logFile: plan.logFile, attempts: 1, status: "dispatch-failed", pr: null };
    writeState(statePath, state);
    appendHerdEvent(eventsPath, {
      now: now(),
      event: "dispatch",
      issue: issue.number,
      adapter: plan.adapter,
      pid: null,
      logFile: plan.logFile,
      attempts: 1,
      status: "dispatch-failed",
    }, log);
    appendEscalation(escalationsPath, {
      now: now(),
      issue: issue.number,
      what: `worker spawn failed for adapter "${plan.adapter}" — the launch command never started (missing or unexecutable binary). Command: ${plan.argv.join(" ")}`,
      adapter: plan.adapter,
      pid: null,
      logFile: plan.logFile,
      attempts: 1,
      status: "dispatch-failed",
      action: "check the adapter's launch command in .ratchet/herd.json; the CLI may be missing from PATH or not executable",
    }, { eventsPath, warn: log });
    return { dispatched: issue.number, claimed: false, status: "dispatch-failed", spawnFailed: true };
  }

  state[issue.number] = { adapter: plan.adapter, pid, logFile: plan.logFile, attempts: 1, status: "dispatched", pr: null };
  writeState(statePath, state);
  appendHerdEvent(eventsPath, {
    now: now(),
    event: "dispatch",
    issue: issue.number,
    adapter: plan.adapter,
    pid,
    logFile: plan.logFile,
    attempts: 1,
    status: "dispatched",
  }, log);

  const { claimed } = await waitForClaim({ gh, issue: issue.number, timeoutMs: claimTimeoutMs, intervalMs: claimIntervalMs, now, sleep });
  if (!claimed) {
    try {
      kill(pid);
      appendHerdEvent(eventsPath, {
        now: now(),
        event: "worker-kill",
        issue: issue.number,
        adapter: plan.adapter,
        pid,
        logFile: plan.logFile,
        attempts: 1,
        status: "dispatch-failed",
      }, log);
    } catch {
      /* worker already gone */
    }
    const after = readState(statePath);
    if (after[issue.number]) {
      after[issue.number].status = "dispatch-failed";
      after[issue.number].pid = null;
      writeState(statePath, after);
    }
    appendEscalation(escalationsPath, {
      now: now(),
      issue: issue.number,
      what: `worker did not claim the issue within ${Math.round(claimTimeoutMs / 1000)}s — the claim signal, the branch ref agent/issue-${issue.number} on origin, never appeared; killed pid ${pid}`,
      adapter: plan.adapter,
      pid,
      logFile: plan.logFile,
      attempts: 1,
      status: "dispatch-failed",
      action: "inspect the log; the adapter CLI may be missing, misconfigured, or failing to claim",
    }, { eventsPath, warn: log });
    return { dispatched: issue.number, claimed: false, status: "dispatch-failed" };
  }
  appendHerdEvent(eventsPath, {
    now: now(),
    event: "claim-detected",
    issue: issue.number,
    adapter: plan.adapter,
    pid,
    logFile: plan.logFile,
    attempts: 1,
    status: "dispatched",
  }, log);
  return { dispatched: issue.number, claimed: true, pid, adapter: plan.adapter };
}
