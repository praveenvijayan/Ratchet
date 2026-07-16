#!/usr/bin/env node
// herd-review.mjs — the ratchet-herd review-verdict reactor. Verification ends a
// worker at the terminal status "ready-for-review" (herd-verify.mjs); nothing
// revisits it, so a human's Request Changes review on that PR used to fall on the
// floor in herd mode — no component polled the PR's review decision, and the
// worker that opened it had already exited (observed on PR #188 / issue #165:
// review submitted CHANGES_REQUESTED, label stuck at state:in-review with no
// rework dispatched). This stage closes that open circuit: each poll it reads the
// review decision of every tracked, ready-for-review PR and, on CHANGES_REQUESTED,
// dispatches exactly one rework worker on the issue's existing branch — the same
// role a human plays in chat mode when they notice the rejection and run
// /ratchet-next. It is detection + dispatch only; it never re-implements rework.
//
// Two signals gate a dispatch, and both must hold:
//   1. the PR's `reviewDecision` is CHANGES_REQUESTED (an APPROVED/COMMENTED/absent
//      verdict dispatches nothing), and
//   2. the latest CHANGES_REQUESTED review's identity is one this stage has not
//      already acted on (`entry.reviewedAt`).
// Signal 2 is the per-rejection dedup, and it is deliberately NOT the
// `state:changes-requested` label. The label would be the obvious dedup, but its
// real-time author (review-verdict, 0098) is silently skipped by GitHub on
// conflicted PRs (`mergeable_state: dirty`) — the exact PRs that most need rework —
// so on a dirty rejection `reviewDecision` reads CHANGES_REQUESTED while the label
// still reads state:in-review for the whole review-verdict-sweep window, and a
// label-gated reactor returns noop the entire time (observed on mdtohtml PR #20 /
// issue #16). So the dedup keys on the rejection's own id instead: for a tracked,
// ready-for-review PR already reading CHANGES_REQUESTED, this stage fetches the
// latest CHANGES_REQUESTED review's node id and acts iff it differs from
// `entry.reviewedAt`, the id it last acted on. `reviewDecision` stays
// CHANGES_REQUESTED until a *new* review lands, so after the worker pushes the id
// is unchanged and no re-dispatch fires — the dedup holds with zero read
// dependency on the label; a genuinely new rejection carries a new id and
// dispatches once more. review-verdict and its sweep stay the board's reconciler
// for chat-mode users; this only removes herd's read dependency on the label. A
// live worker on the entry is never dispatched twice.
//
// A rework here counts against the same `entry.attempts` / `config.reworkCap`
// budget the monitor and verify stages share; at the cap the PR is escalated
// naming it and the cap, never re-dispatched. Like the rest of herd, this stage
// NEVER merges, approves, closes, or labels — the flip back to state:in-review is
// the dispatched worker's job, not the supervisor's. Every outside-world call is
// injectable, so it runs offline in tests. Zero dependencies.

import { substitute } from "./herd-adapters.mjs";
import { STATE_FILE, ESCALATIONS_FILE, EVENTS_FILE, readState, writeState, appendEscalation, appendHerdEvent, isPidAlive } from "./herd-survey.mjs";
import { spawnWorker, recordExit } from "./herd-dispatch.mjs";
import { isConflicting } from "./herd-verify.mjs";

// The rework a changes-requested PR gets: read the review feedback and address it
// on the existing branch, then push and hand the issue back to review. {issue}/{pr}
// are filled in before the adapter argv is rendered. Unlike a fresh dispatch this
// points the worker at the PR's review, and unlike the conflict rework it directs
// the AGENTS.md step 6 flip back to state:in-review so this stage stays label-free.
export const REVIEW_REWORK_PROMPT =
  "PR #{pr} for issue #{issue} received a Request Changes review. In its worktree (../wt/issue-{issue}), " +
  "read the PR's review feedback (the review summary and every line comment), address each point with " +
  "focused commits, re-run the GATES.md gates fail-fast (never push red), and push to update the existing " +
  "PR — do not open a new one. Reply to each review comment with the commit that resolves it, then set the " +
  "issue back to state:in-review for re-review.";

// The rework a PR that is BOTH changes-requested AND conflicting gets. A PR that
// was mergeable at verify time can go dirty once main advances under it; if it
// then draws a Request Changes review, the review-only prompt above would push
// fixes onto a branch still behind main and leave the PR `mergeable_state: dirty`
// with no herd stage ever sending it back through conflict resolution. This prompt
// folds herd-verify's conflict wording ("merge origin/main, resolve every
// conflict") into the review rework, so a successful rework leaves the PR
// mergeable, not dirty. Like REVIEW_REWORK_PROMPT it flips the issue back to
// state:in-review, keeping this stage label-free.
export const REVIEW_CONFLICT_REWORK_PROMPT =
  "PR #{pr} for issue #{issue} received a Request Changes review and now conflicts with main. In its worktree (../wt/issue-{issue}), " +
  "merge origin/main, resolve every conflict, then read the PR's review feedback (the review summary and every line comment) and address each point with " +
  "focused commits, re-run the GATES.md gates fail-fast (never push red), and push to update the existing " +
  "PR — do not open a new one. A successful rework leaves the PR mergeable, not dirty. Reply to each review comment with the commit that resolves it, then set the " +
  "issue back to state:in-review for re-review.";

// Decide a tracked ready-for-review PR's fate from its review decision and the
// identity of its latest rejection versus the one this stage last acted on. Pure
// and total. `reworkCap` bounds the shared automation-attempt budget
// (`entry.attempts`, which dispatch/monitor/verify also count): a review rework is
// one more attempt.
export function classifyReview(issue, entry, { reviewDecision, latestReviewId, reworkCap, conflicting = false }) {
  // Only a Request Changes verdict acts; APPROVED / COMMENTED / null (no required
  // review, or GitHub still computing) dispatch nothing.
  if (reviewDecision !== "CHANGES_REQUESTED") return { action: "noop" };
  // Can't identify the rejection (no CHANGES_REQUESTED review found, or the detail
  // read came back empty) — don't act on an unidentifiable verdict; retry next poll.
  if (!latestReviewId) return { action: "noop" };
  // The per-rejection dedup, keyed on the rejection's own id rather than the label:
  // once this stage has dispatched or escalated on a given review id, that same
  // rejection never fires again — including after the rework worker pushes, when
  // `reviewDecision` is still CHANGES_REQUESTED but the review id is unchanged.
  if (entry.reviewedAt === latestReviewId) return { action: "noop" };
  const attempts = Number.isInteger(entry.attempts) ? entry.attempts : 1;
  // `conflicting` rides through the decision so the dispatch picks the combined
  // conflict+review prompt and the cap escalation names both conditions. It is a
  // second signal on the same rejection, never a second attempt: a conflict rework
  // counts against `reworkCap` exactly like a review-only rework.
  if (attempts >= reworkCap) return { action: "escalate-review-capped", attempts, conflicting };
  return { action: "rework", attempts: attempts + 1, conflicting };
}

// Fetch the identity of a PR's latest CHANGES_REQUESTED review — its node id,
// falling back to `submittedAt` — used as the per-rejection dedup key. Called only
// for the small set of tracked, ready-for-review PRs already reading
// CHANGES_REQUESTED, so the extra per-PR read stays bounded. Returns null when the
// PR carries no CHANGES_REQUESTED review (nothing to dedup on).
export async function latestReviewIdentity(gh, pr) {
  const data = await gh(["pr", "view", String(pr), "--json", "reviews"]);
  const reviews = (data && data.reviews) || [];
  let latest = null;
  for (const r of reviews) {
    if (r.state !== "CHANGES_REQUESTED") continue;
    if (!latest || String(r.submittedAt || "") > String(latest.submittedAt || "")) latest = r;
  }
  if (!latest) return null;
  return String(latest.id || latest.submittedAt || "");
}

// The rework dispatch for a changes-requested PR: the adapter's `resume` argv
// (falling back to `launch`) carrying the review-rework prompt, its env, and the
// same log file. When the PR is also conflicting it carries the combined
// conflict+review prompt so the reworked PR ends up mergeable, not dirty; when it
// is not, the review-only prompt, unchanged. Returns null when the entry's adapter
// is gone from the config — caller escalates.
export function buildReviewRework(config, entry, issue, pr, conflicting = false) {
  const adapter = config.adapters[entry.adapter];
  if (!adapter) return null;
  const command = Array.isArray(adapter.resume) && adapter.resume.length ? adapter.resume : adapter.launch;
  const template = conflicting ? REVIEW_CONFLICT_REWORK_PROMPT : REVIEW_REWORK_PROMPT;
  const prompt = template.replaceAll("{pr}", String(pr)).replaceAll("{issue}", String(issue));
  return {
    argv: substitute(command, { prompt, issue, model: adapter.model }),
    env: adapter.env || {},
    logFile: entry.logFile || `${config.logDir}/issue-${issue}`,
  };
}

// One review-reactor pass: read every open PR's review decision, then for every
// tracked, ready-for-review PR whose verdict is CHANGES_REQUESTED, fetch the latest
// rejection's id and act on the deterministic outcome (rework / escalate / noop)
// keyed on that id versus the one already handled — no label read at all. A failed
// PR survey, or a failed per-PR review-detail read, logs one line and leaves the
// affected entry untouched for the next poll — a transient read never misreads a
// verdict. Returns { ok, transitions }.
export async function reviewOnce(opts) {
  const {
    config,
    statePath = STATE_FILE,
    escalationsPath = ESCALATIONS_FILE,
    eventsPath = EVENTS_FILE,
    gh,
    isAlive = isPidAlive,
    spawn: spawnFn = spawnWorker,
    now = () => Date.now(),
    log = console.log,
  } = opts;

  // Read the review decision AND mergeability of every open PR in the one survey.
  // Mergeability rides along so a PR that turned dirty after promotion to
  // ready-for-review is sent back through conflict resolution as part of its review
  // rework — no herd stage else revisits it. A failed read leaves all entries
  // untouched (retried next poll) rather than risk acting on a stale verdict.
  let openPrs;
  try {
    openPrs = await gh(["pr", "list", "--state", "open", "--json", "number,headRefName,reviewDecision,mergeable,mergeStateStatus", "--limit", "200"]);
  } catch (e) {
    log(`herd: review PR survey failed: ${e.message}; skipping review this poll.`);
    return { ok: false };
  }
  const reviewByHead = new Map(
    (openPrs || []).map((p) => [p.headRefName, { pr: Number(p.number), reviewDecision: p.reviewDecision, mergeable: p.mergeable, mergeStateStatus: p.mergeStateStatus }]),
  );

  const state = readState(statePath);
  const transitions = [];
  for (const [issue, entry] of Object.entries(state)) {
    // A rework already in flight is never dispatched twice.
    if (entry.pid != null && isAlive(entry.pid)) continue;
    // Only revisit PRs the supervisor already declared ready for review — the
    // exact terminal status nothing else reopens.
    if (entry.status !== "ready-for-review") continue;
    const review = reviewByHead.get(`agent/issue-${issue}`);
    if (!review) continue; // no open PR for this issue right now
    // Bound the extra per-PR read: only a CHANGES_REQUESTED verdict is worth a
    // review-detail fetch; every other decision dispatches nothing regardless.
    if (review.reviewDecision !== "CHANGES_REQUESTED") continue;

    // The per-rejection dedup key: the latest CHANGES_REQUESTED review's id. A
    // failed detail read is the same transient-blip case — this entry is left
    // untouched and retried next poll, never acted on from a stale verdict.
    let latestReviewId;
    try {
      latestReviewId = await latestReviewIdentity(gh, review.pr);
    } catch (e) {
      log(`herd: review detail read for PR #${review.pr} failed: ${e.message}; skipping issue #${issue} this poll.`);
      continue;
    }

    // A PR that was mergeable at verify time can go dirty once main advances under
    // it; fold that signal into the rework so review fixes don't land on a branch
    // still behind main and leave the PR unmergeable with nothing to rescue it.
    const conflicting = isConflicting(review);
    const decision = classifyReview(issue, entry, {
      reviewDecision: review.reviewDecision,
      latestReviewId,
      reworkCap: config.reworkCap,
      conflicting,
    });
    if (decision.action === "noop") continue;
    // Mark this rejection handled before acting so the same review id never fires
    // again — the dedup that no longer depends on the label flipping back.
    entry.reviewedAt = latestReviewId;

    const escalate = (what, action) => {
      entry.status = "escalated";
      entry.pid = null;
      appendEscalation(escalationsPath, {
        now: now(),
        issue,
        what,
        adapter: entry.adapter,
        pid: entry.pid,
        logFile: entry.logFile,
        attempts: entry.attempts,
        pr: review.pr,
        status: entry.status,
        action,
      }, { eventsPath, warn: log });
    };
    let line;

    if (decision.action === "escalate-review-capped") {
      // At the cap a conflicting PR is named as both conflicting and
      // changes-requested, so the human knows the branch still needs a merge as
      // well as review fixes; a clean PR keeps the review-only wording.
      const conflictClause = decision.conflicting ? " and conflicts with main" : "";
      escalate(
        `PR #${review.pr} still has a Request Changes review${conflictClause} after ${decision.attempts} attempt(s) — reworkCap ${config.reworkCap} reached, not re-dispatching.`,
        decision.conflicting
          ? `resolve the conflicts and address the review feedback on PR #${review.pr}'s branch by hand, then re-review`
          : `address the review feedback on PR #${review.pr}'s branch by hand, then re-review`,
      );
      line = `herd: issue #${issue} -> escalated (PR #${review.pr} changes-requested${decision.conflicting ? "+conflicting" : ""}; reworkCap ${config.reworkCap} reached after ${decision.attempts} attempts)`;
    } else {
      // rework
      const rework = buildReviewRework(config, entry, issue, review.pr, decision.conflicting);
      if (!rework) {
        escalate(
          `PR #${review.pr} has a Request Changes review but adapter "${entry.adapter}" is no longer in the config — cannot dispatch a rework.`,
          "restore the adapter in .ratchet/herd.json, or address the review feedback by hand",
        );
        line = `herd: issue #${issue} -> escalated (adapter "${entry.adapter}" missing; cannot rework)`;
      } else {
        let pid = null;
        try {
          pid = spawnFn(rework.argv, rework.env, rework.logFile, (code, signal) => recordExit(statePath, issue, code, signal, { config, eventsPath, now, warn: log }));
        } catch (e) {
          escalate(`review rework spawn for PR #${review.pr} failed: ${e.message}`, "check the adapter command in .ratchet/herd.json; the resume CLI may be missing or unexecutable");
          line = `herd: issue #${issue} -> escalated (review rework spawn failed: ${e.message})`;
        }
        if (pid != null) {
          entry.attempts = decision.attempts;
          entry.pid = pid;
          entry.status = "reworking";
          entry.pr = review.pr;
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
            pr: review.pr,
            status: entry.status,
          }, log);
          line = `herd: issue #${issue} -> rework (PR #${review.pr} changes-requested${decision.conflicting ? "+conflicting" : ""}; attempt ${decision.attempts}/${config.reworkCap}, ${entry.adapter} pid ${pid})`;
        }
      }
    }

    log(line);
    transitions.push({ issue: Number(issue), action: decision.action, line });
  }

  writeState(statePath, state);
  return { ok: true, transitions };
}
