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

import { mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { resolveAdapter, substitute, extractUsage, recordAdapterOutcome, createBreaker } from "./herd-adapters.mjs";
import {
  STATE_FILE,
  ESCALATIONS_FILE,
  EVENTS_FILE,
  ROUTING_FILE,
  readState,
  writeState,
  readRouting,
  writeRouting,
  appendEscalation,
  appendHerdEvent,
  isPidAlive,
  claimRefPresent,
  deleteRefCommand,
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
// {prompt}/{issue}/{model} substituted, the merged env, and the log file path.
export function buildDispatch(config, issue, deps = {}) {
  const res = resolveAdapter(config, labelNames(issue), deps);
  // No adapter in the resolved route is available — the caller must not spawn.
  // Carry the route and per-adapter reasons so the escalation can name them all.
  if (!res.adapter)
    return { unavailable: true, source: res.source, route: res.route, tried: res.tried };
  const prompt = substitute(res.adapter.promptTemplate || "", { issue: issue.number, model: res.adapter.model });
  return {
    adapter: res.name,
    argv: substitute(res.adapter.launch, { prompt, issue: issue.number, model: res.adapter.model }),
    env: res.adapter.env || {},
    logFile: `${config.logDir}/issue-${issue.number}.log`,
    // Rotation bookkeeping: the caller advances the route's cursor to nextCursor
    // once it commits to this dispatch, so the next worker on the same route
    // starts at the following adapter. Only meaningful under round-robin.
    policy: res.policy,
    cursorKey: res.cursorKey,
    nextCursor: res.nextCursor,
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
export function recordExit(path, issue, code, signal, { config, eventsPath = EVENTS_FILE, now = Date.now, warn = console.warn } = {}) {
  const state = readState(path);
  const entry = state[issue];
  if (!entry) return;
  const pid = entry.pid;
  entry.exitCode = code == null ? null : Number(code);
  entry.exitSignal = signal || null;
  entry.pid = null;
  writeState(path, state);

  // If this worker's adapter declares a usage mapping, read its cost/token
  // numbers from the log and carry them on the worker-exit event so any consumer
  // reads one adapter-agnostic source. An adapter with no mapping omits the
  // fields entirely (back-compat). A log that can't be read (crashed/truncated
  // worker) or lacks the declared values records the fields as null and warns —
  // the exit path never throws, so the poll always continues.
  let usage;
  const adapter = config && config.adapters ? config.adapters[entry.adapter] : undefined;
  if (adapter && adapter.usage) {
    let logText = "";
    try {
      if (entry.logFile) logText = readFileSync(entry.logFile, "utf8");
    } catch {
      // Unreadable or missing log — extraction below yields nulls and warns.
    }
    const { values, unresolved } = extractUsage(adapter.usage, logText);
    usage = values;
    if (unresolved.length)
      warn(
        `herd: warning: could not read usage field(s) ${unresolved.join(", ")} for adapter "${entry.adapter}" ` +
          `from ${entry.logFile || "(no log file)"}; recorded as null.`,
      );
  }

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
    ...(usage || {}),
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
// never (on its own) as a dispatch failure.
//
// The pass emitted its heartbeat once at the top of pollOnce, but this wait can
// block the whole pass for up to claimTimeoutSeconds — long past the dashboard's
// silence threshold — so a stuck dispatch would falsely alarm "supervisor silent"
// while the supervisor is alive and busy-waiting here (issue-0285). We beat again
// on the poll cadence throughout the wait: `heartbeat` fires no more than once per
// `heartbeatIntervalMs` so the events stream isn't flooded, and it's a no-op when
// unset (0 interval) so direct callers and tests keep the old behaviour. The
// heartbeat itself must swallow its own write failure (see dispatchOne), so a
// broken events path never aborts the wait.
//
// `hasExited` reports whether the spawned worker's process has already exited
// (issue-0286). A worker that dies before creating its claim ref can never claim,
// so once it has exited we stop waiting immediately rather than burning the whole
// timeout on a dead process — the ref check runs first every pass, so a worker
// that claimed and *then* exited still reports claimed. Returns { claimed } on a
// claim, or { claimed: false, exited } on the exit short-circuit (exited: true)
// versus the plain timeout (exited: false).
export async function waitForClaim({
  gh,
  issue,
  timeoutMs,
  intervalMs = 1000,
  now = () => Date.now(),
  sleep = defaultSleep,
  heartbeat = null,
  heartbeatIntervalMs = 0,
  hasExited = () => false,
}) {
  const ref = `repos/{owner}/{repo}/git/ref/heads/agent/issue-${issue}`;
  const start = now();
  let lastBeat = start; // the pass already beat at its start; the next is due one interval on
  for (;;) {
    try {
      await gh(["api", ref]);
      return { claimed: true }; // the ref resolves -> the worker claimed the issue
    } catch {
      // ref not created yet (404) or a transient gh error — keep waiting
    }
    // The worker's process exited before its claim ref appeared. It can no
    // longer claim, so end the wait within this poll interval instead of
    // running to the full timeout. The caller re-checks origin for a raced ref.
    if (hasExited()) return { claimed: false, exited: true };
    if (now() - start >= timeoutMs) return { claimed: false, exited: false };
    await sleep(intervalMs);
    if (heartbeat && heartbeatIntervalMs > 0 && now() - lastBeat >= heartbeatIntervalMs) {
      heartbeat();
      lastBeat = now();
    }
  }
}

// Dispatch at most one worker this pass. Skips issues already in the state file
// (one worker per issue, ever) and refuses to exceed maxWorkers. On --dry-run
// it returns the plan without spawning. After spawning it serializes on the
// claim window; a timeout kills the worker, marks it dispatch-failed, and
// escalates.
// Escalate a fully circuit-broken route exactly once per run (issue #428,
// criterion 4). Every adapter the route resolves to has tripped, so no issue on
// it can be dispatched; list each adapter with its consecutive-failure count so
// the operator sees the whole picture, then never re-escalate this route —
// affected issues simply wait rather than the supervisor spinning on retries.
function escalateRouteExhausted(breaker, res, issueNumber, { escalationsPath, eventsPath, now, log }) {
  if (breaker.routeEscalated[res.source]) return;
  breaker.routeEscalated[res.source] = true;
  const counts = res.route.map((name) => `${name} (${breaker.failures[name] || 0} consecutive claim failures)`).join(", ");
  appendEscalation(escalationsPath, {
    now: now(),
    issue: issueNumber,
    what: `every adapter in route ${res.source} [${res.route.join(", ")}] has tripped the circuit breaker — ${counts}; no worker can be dispatched for issues on this route, so dispatch is stopped for the rest of this run`,
    adapter: null,
    pid: null,
    logFile: null,
    attempts: 1,
    status: "dispatch-failed",
    action: "fix or replace the adapters in this route in .ratchet/herd.json, then restart the herd to re-enable dispatch",
  }, { eventsPath, warn: log });
}

export async function dispatchOne(opts) {
  const {
    config,
    ready,
    statePath = STATE_FILE,
    escalationsPath = ESCALATIONS_FILE,
    eventsPath = EVENTS_FILE,
    routingPath = ROUTING_FILE,
    spawn: spawnFn = spawnWorker,
    gh,
    isAlive = isPidAlive,
    now = () => Date.now(),
    sleep = defaultSleep,
    log = console.log,
    kill = defaultKill,
    dryRun = false,
    // Optional issue-targeting filter (parsed by parseIssueTargets in herd.mjs):
    // null dispatches the whole queue; an array restricts dispatch to those issue
    // numbers — intersected with the ready survey below, so an issue outside the
    // ready set is never dispatched even when named.
    targets = null,
    maxWorkers = config.maxWorkers,
    claimTimeoutMs = (config.claimTimeoutSeconds ?? 300) * 1000,
    claimIntervalMs = 1000,
    // Keep the fleet heartbeat alive while the claim wait blocks the pass, on the
    // same poll cadence the loop beats at otherwise. See waitForClaim (issue-0285).
    heartbeatIntervalMs = (config.pollSeconds ?? 60) * 1000,
    env = process.env,
    onPath,
    // Fired locally after recordExit when this worker's process exits, so the
    // supervisor reacts without waiting for the next tick (plan 0173). Optional;
    // a listener throw is swallowed so it can never crash the worker-exit path.
    notifyExit = null,
    // The circuit breaker shared across this run's dispatches (issue #428). The
    // run entry (herd.mjs) creates one and threads it through every tick's
    // supervisorStep, so a tripped adapter stays tripped for the rest of the run;
    // a bare dispatchOne call (tests) defaults to a fresh, isolated breaker.
    breaker = createBreaker(),
    adapterFailureThreshold = config.adapterFailureThreshold ?? 2,
  } = opts;

  const state = readState(statePath);
  // One worker per issue, ever (skip issues already in the state file); then, if
  // a target set was given, intersect with it — targeting filters the ready
  // queue, it never bypasses eligibility, so an issue outside the ready survey
  // is unreachable even when explicitly named.
  const untracked = (ready || []).filter((i) => !(String(i.number) in state));
  const targetSet = targets == null ? null : new Set(targets);
  const candidates = targetSet ? untracked.filter((i) => targetSet.has(i.number)) : untracked;

  const cursors = readRouting(routingPath);
  // Drop candidates whose *entire* route is circuit-broken: routing has nothing
  // available for them this run, so they are not dispatchable. Each such route is
  // escalated once (breaker.routeEscalated), listing every adapter's failure
  // count, then the affected issues simply wait — the supervisor never spins
  // retrying a route it has already given up on (issue #428, criterion 4).
  const eligible = [];
  for (const i of candidates) {
    const res = resolveAdapter(config, labelNames(i), { env, onPath, cursors, breaker });
    if (res.name == null && res.tried.some((t) => t.tripped)) {
      escalateRouteExhausted(breaker, res, i.number, { escalationsPath, eventsPath, now, log });
      continue;
    }
    eligible.push(i);
  }
  const issue = pickNext(eligible);
  if (!issue) return { dispatched: null, reason: "no-eligible-issue" };

  const plan = buildDispatch(config, issue, { env, onPath, cursors, breaker });

  // No adapter in the resolved route is available: do not spawn. Record the
  // issue as dispatch-failed and escalate with the route and every adapter tried
  // (each with why it was unavailable), so the operator knows exactly what to fix.
  if (plan.unavailable) {
    const detail = plan.tried.map((t) => `${t.name} (${t.reason})`).join("; ");
    if (dryRun)
      return { dispatched: null, dryRun: true, plan: { issue: issue.number, adapter: null, unavailable: true, route: plan.route, tried: plan.tried } };
    state[issue.number] = { adapter: null, pid: null, logFile: null, attempts: 1, status: "dispatch-failed", pr: null };
    writeState(statePath, state);
    appendHerdEvent(eventsPath, {
      now: now(),
      event: "dispatch",
      issue: issue.number,
      adapter: null,
      pid: null,
      logFile: null,
      attempts: 1,
      status: "dispatch-failed",
    }, log);
    appendEscalation(escalationsPath, {
      now: now(),
      issue: issue.number,
      what: `no adapter is available for route ${plan.source} [${plan.route.join(", ")}] — tried ${plan.tried.length} adapter(s): ${detail}. The issue was not dispatched.`,
      adapter: null,
      pid: null,
      logFile: null,
      attempts: 1,
      status: "dispatch-failed",
      action: "install a missing adapter binary or set the missing environment variable(s) named above, or edit the route in .ratchet/herd.json to list an available adapter",
    }, { eventsPath, warn: log });
    return { dispatched: issue.number, claimed: false, status: "dispatch-failed", unavailable: true, route: plan.route, tried: plan.tried };
  }

  if (dryRun) {
    log(`herd dry-run: issue #${issue.number} -> ${plan.adapter}: ${plan.argv.join(" ")}`);
    return { dispatched: null, dryRun: true, plan: { issue: issue.number, adapter: plan.adapter, command: plan.argv } };
  }

  const live = liveWorkers(state, isAlive);
  if (live >= maxWorkers) return { dispatched: null, reason: "at-capacity", live, maxWorkers };

  // Feed this dispatch's outcome to the circuit breaker (issue #428). A failure
  // is a worker that exits without claiming, dies within the claim window after
  // claiming, or never spawns; a success is a live claim. When the failure that
  // trips the adapter is the one just recorded, surface it once as degraded —
  // subsequent failures on the same adapter return justTripped=false, so the
  // degraded notice is never re-reported every tick (criterion 3).
  const noteOutcome = (ok) => {
    const r = recordAdapterOutcome(breaker, plan.adapter, ok, adapterFailureThreshold);
    if (r.justTripped) {
      appendEscalation(escalationsPath, {
        now: now(),
        issue: issue.number,
        what: `adapter "${plan.adapter}" tripped the circuit breaker after ${r.failures} consecutive claim failures (a worker exited without claiming, or died within the claim window after claiming) — it is skipped for the rest of this run`,
        adapter: plan.adapter,
        pid: null,
        logFile: plan.logFile,
        attempts: 1,
        status: "dispatch-failed",
        action: "inspect this adapter's log and its launch/config in .ratchet/herd.json; restart the herd after fixing to re-enable the adapter",
      }, { eventsPath, warn: log });
    }
  };

  // Commit to this dispatch: advance the route's round-robin cursor so the next
  // worker on the same route starts at the following adapter. Written before the
  // spawn (not after) so a crash mid-spawn still rotates — a broken adapter is
  // already skipped by the availability check, so never re-pinning it is correct.
  // Failover leaves the cursor untouched, so its state file stays empty.
  if (plan.policy === "round-robin") {
    cursors[plan.cursorKey] = plan.nextCursor;
    writeRouting(routingPath, cursors);
  }

  // Capture the worker's exit so the claim wait can short-circuit when the
  // process dies before claiming (issue #286). recordExit still runs — it clears
  // the pid and records the exit code/usage for the monitor exactly as before.
  let workerExit = null;
  const onExit = (code, signal) => {
    workerExit = { code, signal };
    recordExit(statePath, issue.number, code, signal, { config, eventsPath, now, warn: log });
    if (notifyExit) {
      try {
        notifyExit(issue.number, code, signal);
      } catch {
        /* a supervisor listener must never crash the worker-exit path */
      }
    }
  };
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
    noteOutcome(false);
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

  // Beat the fleet heartbeat across the wait so a dispatch stuck for the full
  // claimTimeoutSeconds never reads as a silent supervisor. Its own write failure
  // is swallowed (warn: () => {}), matching pollOnce's heartbeat error policy, so
  // a broken events path never aborts the wait or the pass.
  const heartbeat = () => appendHerdEvent(eventsPath, { now: now(), event: "heartbeat" }, () => {});
  const { claimed, exited } = await waitForClaim({
    gh,
    issue: issue.number,
    timeoutMs: claimTimeoutMs,
    intervalMs: claimIntervalMs,
    now,
    sleep,
    heartbeat,
    heartbeatIntervalMs,
    hasExited: () => workerExit != null,
  });

  // The worker's process exited before the wait saw its claim ref. It is
  // already dead, so there is nothing to kill. But an exit right after a claim
  // races the ref check, so re-check origin (the same guard the kill path uses,
  // issue #138): a present ref is a real claim the worker made before exiting —
  // report it claimed, never dispatch-failed (issue #286). Only an exit with no
  // ref is a genuine early death, escalated distinctly from the timeout.
  if (!claimed && exited) {
    const refLeft = await claimRefPresent(gh, issue.number);
    if (refLeft) {
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
      // The issue is genuinely claimed, but the worker died within its claim
      // window right after claiming — the adapter is flaky, so this counts as a
      // claim failure for the breaker even though the claim itself stands (#428).
      noteOutcome(false);
      return { dispatched: issue.number, claimed: true, pid, adapter: plan.adapter };
    }
    const after = readState(statePath);
    if (after[issue.number]) {
      after[issue.number].status = "dispatch-failed";
      after[issue.number].pid = null;
      writeState(statePath, after);
    }
    const sec = Math.round(claimTimeoutMs / 1000);
    const how =
      workerExit.code != null
        ? `exit code ${Number(workerExit.code)}`
        : workerExit.signal
          ? `signal ${workerExit.signal}`
          : "an unknown exit";
    appendEscalation(escalationsPath, {
      now: now(),
      issue: issue.number,
      what: `worker for adapter "${plan.adapter}" exited (${how}) before creating its claim ref agent/issue-${issue.number} on origin — it can no longer claim, so the ${sec}s claim wait was ended on the observed exit rather than run to the timeout; the issue was never claimed (pid ${pid})`,
      adapter: plan.adapter,
      pid,
      logFile: plan.logFile,
      attempts: 1,
      status: "dispatch-failed",
      action: "inspect the log for why the worker exited on startup; the adapter CLI may be crashing, misconfigured, or exiting before it can claim",
    }, { eventsPath, warn: log });
    noteOutcome(false);
    return { dispatched: issue.number, claimed: false, status: "dispatch-failed", exited: true };
  }

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
    // The kill can race the worker: a worker can create its claim ref right
    // around the SIGTERM, leaving a ref no live worker backs — itself a stale
    // claim. Re-check origin after the kill so we don't report "the ref never
    // appeared" when it actually exists, and hand the operator the same delete
    // command the survey's stale-claim escalation uses. A 404 or transient gh
    // error reads as absent, keeping the plain timeout message.
    const sec = Math.round(claimTimeoutMs / 1000);
    const refLeft = await claimRefPresent(gh, issue.number);
    const del = deleteRefCommand(issue.number);
    const what = refLeft
      ? `worker did not claim the issue within ${sec}s so it was killed (pid ${pid}), but the claim ref agent/issue-${issue.number} on origin was created anyway — the killed worker raced the timeout and left a stale claim that 422s every future worker. Delete it: ${del}`
      : `worker did not claim the issue within ${sec}s — the claim signal, the branch ref agent/issue-${issue.number} on origin, never appeared; killed pid ${pid}`;
    const action = refLeft
      ? `run \`${del}\` to delete the stale claim ref the killed worker left, then inspect the log; the adapter CLI may be misconfigured`
      : "inspect the log; the adapter CLI may be missing, misconfigured, or failing to claim";
    appendEscalation(escalationsPath, {
      now: now(),
      issue: issue.number,
      what,
      adapter: plan.adapter,
      pid,
      logFile: plan.logFile,
      attempts: 1,
      status: "dispatch-failed",
      action,
    }, { eventsPath, warn: log });
    noteOutcome(false);
    return { dispatched: issue.number, claimed: false, status: "dispatch-failed", staleRef: refLeft };
  }
  noteOutcome(true);
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

// One supervisor pass, kind-aware (plan 0173) — it changes *when* passes run,
// never *what* they do. `kind: "tick"` heartbeats + surveys upstream (pollOnce,
// which returns `{ skipped }` on an all-304 tick), runs retention, and — only
// when the survey saw a change — the upstream verify/review. `kind: "event"` is
// the lean reactive pass a local worker exit fires: no pollOnce (so it neither
// adds nor suppresses heartbeats) and no upstream verify/review. Both kinds run
// the pid-liveness monitor and then DRAIN dispatch — dispatchOne back-to-back
// until at-capacity or no eligible issue, so N targets launch as each preceding
// claim is observed, not one per tick. The drain is sequential and each
// dispatchOne serializes its own claim window, so two never overlap. Every stage
// is injected (defaulting to this module's dispatchOne/surveyReady) for offline
// tests.
export async function supervisorStep(o) {
  const {
    kind = "tick",
    gh,
    dryRun = false,
    targets = null,
    log = console.log,
    config,
    maxWorkers = config?.maxWorkers,
    pollOnce = null,
    monitorOnce = null,
    verifyOnce = null,
    reviewOnce = null,
    retentionOnce = null,
    surveyReady: survey = surveyReady,
    dispatchOne: dispatch = dispatchOne,
  } = o;
  // Only a tick surveys upstream; an event pass treats upstream as unchanged.
  let upstreamChanged = false;
  if (kind === "tick" && pollOnce) upstreamChanged = !(await pollOnce(o))?.skipped;
  if (!dryRun) {
    // Monitor is pid-liveness-driven (no upstream), so it runs every pass — the
    // core reaction to a worker exit. Verify/review are upstream, tick-gated.
    if (monitorOnce)
      await monitorOnce(o).catch((e) => log(`herd: monitor failed: ${e.message}; continuing to dispatch.`));
    if (upstreamChanged) {
      if (verifyOnce)
        await verifyOnce(o).catch((e) => log(`herd: verify failed: ${e.message}; continuing to dispatch.`));
      if (reviewOnce)
        await reviewOnce(o).catch((e) => log(`herd: review failed: ${e.message}; continuing to dispatch.`));
    }
  }
  // Retention is tick-cadence local cleanup (dry-run included); off the event path.
  if (kind === "tick" && retentionOnce)
    await retentionOnce(o).catch((e) => log(`herd: retention failed: ${e.message}; continuing.`));
  const ready = await survey(gh).catch((e) => {
    log(`herd: dispatch survey failed: ${e.message}; skipping dispatch this poll.`);
    return [];
  });
  // Drain: dispatch while the last call did something (claimed or dispatch-failed
  // both free the next issue); stop on at-capacity/no-eligible. --dry-run previews
  // one plan (dispatched: null) and stops.
  let r;
  let launched = 0;
  do {
    r = await dispatch({ ...o, ready, dryRun, targets, maxWorkers });
    if (r && r.claimed) launched += 1;
  } while (!dryRun && r && r.dispatched != null);
  return { kind, ready: ready.length, launched, upstreamChanged };
}
