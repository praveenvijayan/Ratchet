#!/usr/bin/env node
// herd-verify.mjs — the ratchet-herd PR verification stage. The monitor marks a
// worker "awaiting-verification" once its run opened a PR (head agent/issue-<N>);
// this stage runs *deterministic* checks on that PR and routes the outcome. It
// makes no scope or quality judgment — that stays with the human. The three
// deterministic outcomes:
//   1. conflicts (`mergeable` CONFLICTING / `mergeStateStatus` DIRTY) -> dispatch
//      exactly one rework (merge origin/main, resolve, re-run GATES.md gates,
//      push), counted toward `reworkCap`. A PR still conflicting after that, or
//      one already at `reworkCap`, is escalated instead of re-dispatched.
//   2. body missing `Closes #<N>` or a gates section (text checks only) ->
//      escalate; the supervisor never edits a PR body.
//   3. clean (no conflicts, `Closes #<N>` and a gates section present) ->
//      escalate "PR #X ready for review" — the supervisor's terminal act.
// Mergeability GitHub is still computing (`mergeable` not yet MERGEABLE and no
// conflict) is deferred to the next poll rather than mis-classified.
//
// Like the rest of herd, this stage NEVER merges, approves, closes, or labels a
// PR — it only reads (`gh pr view`), dispatches reworks, and escalates. Every
// outside-world call is injectable, so it runs offline in tests. Zero deps.

import { substitute } from "./herd.mjs";
import { STATE_FILE, ESCALATIONS_FILE, EVENTS_FILE, readState, writeState, appendEscalation, appendHerdEvent } from "./herd-survey.mjs";
import { spawnWorker, recordExit } from "./herd-dispatch.mjs";

// The rework a conflicting PR gets: resolve against main and push the same
// branch. {issue}/{pr} are filled in before the adapter argv is rendered.
export const REWORK_PROMPT =
  "PR #{pr} for issue #{issue} conflicts with main. In its worktree (../wt/issue-{issue}), " +
  "merge origin/main, resolve every conflict, re-run the GATES.md gates fail-fast (never push red), " +
  "and push to update the existing PR. Do not open a new PR.";

// True when GitHub reports the PR cannot merge cleanly. Either signal is
// authoritative: `mergeable` CONFLICTING, or the merge-state DIRTY.
export function isConflicting(prView) {
  return prView?.mergeable === "CONFLICTING" || prView?.mergeStateStatus === "DIRTY";
}

// Text-only check: does the body reference this issue with a GitHub closing
// keyword (Closes/Fixes/Resolves #<N>)? The referenced number must be THIS
// issue — a body that closes some other issue does not count.
export function hasClosesRef(body, issue) {
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
  let m;
  while ((m = re.exec(String(body))) !== null) {
    if (Number(m[1]) === Number(issue)) return true;
  }
  return false;
}

// Text-only check: does the body carry a gates section — a markdown heading or
// bold label whose name starts with "gate" (## Gates, ### Gate results,
// **Gates**)? A bare mention of the word is not a section.
export function hasGatesSection(body) {
  return /(^|\n)\s{0,3}(#{1,6}\s*|\*\*\s*)gate/i.test(String(body));
}

// Decide a PR's verification outcome from its `gh pr view` JSON. Pure and total.
// `reworkCap` bounds the shared automation-attempt budget (`entry.attempts`,
// which dispatch/monitor also count): a conflict rework is one more attempt.
export function classifyVerification(issue, entry, prView, { reworkCap }) {
  if (isConflicting(prView)) {
    const attempts = Number.isInteger(entry.attempts) ? entry.attempts : 1;
    if (attempts >= reworkCap) return { action: "escalate-conflict-capped", attempts };
    return { action: "rework", attempts: attempts + 1 };
  }
  // Not conflicting, but GitHub may still be computing mergeability — defer
  // rather than treat an unknown state as clean.
  if (prView?.mergeable !== "MERGEABLE") return { action: "recheck" };

  const body = typeof prView.body === "string" ? prView.body : "";
  const missing = [];
  if (!hasClosesRef(body, issue)) missing.push(`Closes #${issue}`);
  if (!hasGatesSection(body)) missing.push("a gates section");
  if (missing.length) return { action: "escalate-body", missing };
  return { action: "escalate-ready" };
}

// The rework dispatch for a conflicting PR: the adapter's `resume` argv (falling
// back to `launch`) carrying the rework prompt, its env, and the same log file.
// Returns null when the entry's adapter is gone from the config — caller escalates.
export function buildRework(config, entry, issue, pr) {
  const adapter = config.adapters[entry.adapter];
  if (!adapter) return null;
  const command = Array.isArray(adapter.resume) && adapter.resume.length ? adapter.resume : adapter.launch;
  const prompt = REWORK_PROMPT.replaceAll("{pr}", String(pr)).replaceAll("{issue}", String(issue));
  return {
    argv: substitute(command, { prompt, issue, model: adapter.model }),
    env: adapter.env || {},
    logFile: entry.logFile || `${config.logDir}/issue-${issue}.log`,
  };
}

// One verification pass: for every worker awaiting verification, read its PR and
// act on the deterministic outcome (rework / escalate / ready). A single PR
// whose `gh pr view` fails is logged and left for the next poll — one bad PR
// never aborts the pass. Returns { ok, transitions }.
export async function verifyOnce(opts) {
  const {
    config,
    statePath = STATE_FILE,
    escalationsPath = ESCALATIONS_FILE,
    eventsPath = EVENTS_FILE,
    gh,
    spawn: spawnFn = spawnWorker,
    now = () => Date.now(),
    log = console.log,
  } = opts;

  const state = readState(statePath);
  const transitions = [];
  for (const [issue, entry] of Object.entries(state)) {
    if (entry.status !== "awaiting-verification") continue;
    if (entry.pr == null) continue; // monitor sets pr alongside this status; defensive

    let prView;
    try {
      prView = await gh(["pr", "view", String(entry.pr), "--json", "mergeable,mergeStateStatus,body"]);
    } catch (e) {
      log(`herd: verify of PR #${entry.pr} (issue #${issue}) failed: ${e.message}; retrying next poll.`);
      continue; // leave awaiting-verification so the next poll retries
    }

    const decision = classifyVerification(issue, entry, prView, { reworkCap: config.reworkCap });
    const escalate = (what, action) => {
      entry.status = "verify-escalated";
      entry.pid = null;
      appendEscalation(escalationsPath, {
        now: now(),
        issue,
        what,
        adapter: entry.adapter,
        pid: entry.pid,
        logFile: entry.logFile,
        attempts: entry.attempts,
        pr: entry.pr,
        status: entry.status,
        action,
      }, { eventsPath, warn: log });
    };
    let line;

    if (decision.action === "recheck") {
      // No state change — GitHub is still computing mergeability.
      line = `herd: issue #${issue} -> verify deferred (PR #${entry.pr} mergeability still computing)`;
    } else if (decision.action === "escalate-ready") {
      entry.status = "ready-for-review";
      entry.pid = null;
      appendEscalation(escalationsPath, {
        now: now(),
        issue,
        what: `PR #${entry.pr} ready for review — passed deterministic checks (no conflicts; Closes #${issue} and a gates section present).`,
        adapter: entry.adapter,
        pid: entry.pid,
        logFile: entry.logFile,
        attempts: entry.attempts,
        pr: entry.pr,
        status: entry.status,
        action: `review PR #${entry.pr} and merge it, or request changes — the supervisor never merges or approves`,
      }, { eventsPath, warn: log });
      line = `herd: issue #${issue} -> PR #${entry.pr} ready for review`;
    } else if (decision.action === "escalate-body") {
      const missing = decision.missing.join(" and ");
      escalate(
        `PR #${entry.pr} body is missing ${missing} (deterministic text check). The supervisor does not edit PR bodies.`,
        `add ${decision.missing.join(", ")} to PR #${entry.pr}'s body, or ask the author to`,
      );
      line = `herd: issue #${issue} -> escalated (PR #${entry.pr} body missing ${missing})`;
    } else if (decision.action === "escalate-conflict-capped") {
      escalate(
        `PR #${entry.pr} still conflicts with main after ${decision.attempts} attempt(s) — reworkCap ${config.reworkCap} reached, not re-dispatching.`,
        `resolve the conflicts on PR #${entry.pr}'s branch by hand, then re-review`,
      );
      line = `herd: issue #${issue} -> escalated (PR #${entry.pr} conflicts; reworkCap ${config.reworkCap} reached after ${decision.attempts} attempts)`;
    } else {
      // rework
      const rework = buildRework(config, entry, issue, entry.pr);
      if (!rework) {
        escalate(
          `PR #${entry.pr} conflicts but adapter "${entry.adapter}" is no longer in the config — cannot dispatch a rework.`,
          "restore the adapter in .ratchet/herd.json, or resolve the conflicts by hand",
        );
        line = `herd: issue #${issue} -> escalated (adapter "${entry.adapter}" missing; cannot rework)`;
      } else {
        let pid = null;
        try {
          pid = spawnFn(rework.argv, rework.env, rework.logFile, (code, signal) => recordExit(statePath, issue, code, signal, { eventsPath, now, warn: log }));
        } catch (e) {
          escalate(`rework spawn for PR #${entry.pr} failed: ${e.message}`, "check the adapter command in .ratchet/herd.json; the resume CLI may be missing or unexecutable");
          line = `herd: issue #${issue} -> escalated (rework spawn failed: ${e.message})`;
        }
        if (pid != null) {
          entry.attempts = decision.attempts;
          entry.pid = pid;
          entry.status = "reworking";
          delete entry.exitCode; // a stale exit must not re-classify the rework run
          delete entry.exitSignal;
          appendHerdEvent(eventsPath, {
            now: now(),
            event: "rework",
            issue,
            adapter: entry.adapter,
            pid,
            logFile: rework.logFile,
            attempts: entry.attempts,
            pr: entry.pr,
            status: entry.status,
          }, log);
          line = `herd: issue #${issue} -> rework (PR #${entry.pr} conflicts; attempt ${decision.attempts}/${config.reworkCap}, ${entry.adapter} pid ${pid})`;
        }
      }
    }

    log(line);
    transitions.push({ issue: Number(issue), action: decision.action, line });
  }

  writeState(statePath, state);
  return { ok: true, transitions };
}
