#!/usr/bin/env node
// auto-merge.mjs — tiered review. Uniform review is the bottleneck and the gap
// at once: low-risk PRs wait on a human who adds little, high-risk PRs get the
// same skim. This sweep tiers the merge bar on the plan-declared risk label
// (ratchet-submit inherits `risk:high` from the issue onto the PR). Normal risk:
// green checks plus an APPROVED recorded verdict merges, no human action.
// `risk:high`: never on the verdict alone — it also needs a human APPROVED
// review and HOLD_MINUTES elapsed since the PR became mergeable. A
// changes-requested verdict never merges; that PR belongs to the existing rework
// path (review-verdict flips its issue). Every merge records what it acted on;
// every failed merge comments why and is never retried for that head SHA — no
// silent retry loop. Reuses latestReviewState from review-verdict-sweep.mjs so
// "the latest review" means one thing repo-wide. Decision logic is
// regression-tested off the network (auto-merge.test.mjs); the workflow is only
// its trigger and env. Zero dependencies. Node 20+ (ESM).

import { fileURLToPath } from "node:url";
import { ghClient, paginate, resolveAuth } from "./gh-api.mjs";
import { latestReviewState } from "./review-verdict-sweep.mjs";

export const RISK_HIGH = "risk:high";
export const HOLD_MINUTES = 15;
export const RECORD_MARKER = "<!-- ratchet-auto-merge -->";
export const FAILED_MARKER = (sha) => `<!-- ratchet-auto-merge-failed:${sha} -->`;

const labelNames = (labels) => (labels || []).map((l) => (typeof l === "string" ? l : l.name));
const isBot = (user) => user?.type === "Bot" || /\[bot\]$/.test(user?.login || "");

// Roll a commit's check runs into one state. `failure` if any run concluded
// badly, `pending` while any run is unfinished (or none have reported yet),
// `success` only when every run finished acceptably — neutral and skipped count
// as acceptable, matching how GitHub renders a green PR.
export function checkState(checkRuns = []) {
  if (!checkRuns.length) return "pending";
  const bad = new Set(["failure", "cancelled", "timed_out", "action_required", "stale"]);
  if (checkRuns.some((r) => bad.has(r.conclusion))) return "failure";
  if (checkRuns.some((r) => r.status !== "completed")) return "pending";
  return "success";
}

// When the PR became mergeable: the newest check-run completion on the head
// commit. That is the clock the risk:high hold measures against. Null when no
// run reports a completion — a hold with no start never elapses, so risk:high
// waits rather than merging on an unknown age.
export function mergeableSince(checkRuns = []) {
  const stamps = checkRuns.map((r) => r.completed_at).filter(Boolean);
  if (!stamps.length) return null;
  return stamps.map((s) => new Date(s)).sort((a, b) => b - a)[0].toISOString();
}

// The pure decision; all API data is fetched by the orchestration below.
// `labels` carries risk:high (inherited by ratchet-submit), `checks` is a
// checkState value, `verdict` the latest recorded review state from any author,
// `humanVerdict` the latest from a non-bot author, `since`/`now` bound the
// risk:high hold. Returns { merge, reason, tier, heldMinutes }.
export function decideMerge({ labels = [], draft = false, checks, verdict, humanVerdict = null, since = null, now, holdMinutes = HOLD_MINUTES }) {
  const tier = labelNames(labels).includes(RISK_HIGH) ? "high" : "normal";
  const heldMinutes = since ? Math.floor((new Date(now) - new Date(since)) / 60000) : null;
  const no = (reason) => ({ merge: false, reason, tier, heldMinutes });

  if (draft) return no("draft PR — not merged");
  if (checks !== "success") return no(`checks are ${checks} — not merged`);
  if (verdict !== "APPROVED") {
    return no(`recorded review verdict is ${verdict ?? "none"} — the rework path owns this PR`);
  }
  if (tier === "high") {
    if (humanVerdict !== "APPROVED") return no("risk:high needs a human approval — not merged");
    if (heldMinutes === null) return no("risk:high needs a mergeable-since timestamp to hold against — not merged");
    if (heldMinutes < holdMinutes) {
      return no(`risk:high hold — ${heldMinutes} of ${holdMinutes} min elapsed since mergeable`);
    }
  }
  return { merge: true, reason: `${tier}-risk PR: checks ${checks}, verdict ${verdict}`, tier, heldMinutes };
}

// The comment a merge leaves behind, so the PR shows what the automation acted
// on after the fact (criterion 4).
export function recordComment({ tier, checks, verdict, humanVerdict, heldMinutes }) {
  const lines = [
    RECORD_MARKER,
    "**Auto-merged by ratchet tiered review.**",
    "",
    `- risk tier: \`${tier === "high" ? RISK_HIGH : "normal"}\``,
    `- check state: \`${checks}\``,
    `- recorded review verdict: \`${verdict}\``,
  ];
  if (tier === "high") {
    lines.push(`- human review verdict: \`${humanVerdict}\``);
    lines.push(`- held \`${heldMinutes}\` min since mergeable (minimum \`${HOLD_MINUTES}\`)`);
  }
  return lines.join("\n");
}

// --- orchestration: the sweep the workflow runs -----------------------------
// Everything above is the pure core. Below is the thin driver: list open PRs,
// gather each one's checks and reviews, decide, merge, and record. A GitHub API
// failure on one PR is logged and never aborts the remaining PRs.

export async function main({ auth = resolveAuth, fetchImpl, now = () => new Date().toISOString() } = {}) {
  const { token, repo } = auth();
  const gh = ghClient(token, { fetchImpl });

  let prs;
  try {
    prs = await paginate(gh, `/repos/${repo}/pulls?state=open`);
  } catch (e) {
    throw new Error(`could not list open PRs: ${e.status ?? e.message}`);
  }

  let merged = 0;
  for (const pr of prs) {
    const sha = pr.head?.sha;
    let checkRuns, reviews, comments;
    try {
      checkRuns = (await gh("GET", `/repos/${repo}/commits/${sha}/check-runs`)).check_runs || [];
      reviews = await paginate(gh, `/repos/${repo}/pulls/${pr.number}/reviews`);
      comments = await paginate(gh, `/repos/${repo}/issues/${pr.number}/comments`);
    } catch (e) {
      console.log(`PR #${pr.number}: could not read merge inputs (${e.status ?? e.message}) — skipping.`);
      continue;
    }

    // A recorded failure for this exact head SHA means we already tried and
    // said why: never retry the same SHA (criterion 5 — no silent retry loop).
    if (comments.some((c) => (c.body || "").includes(FAILED_MARKER(sha)))) {
      console.log(`PR #${pr.number}: auto-merge already failed for ${sha} — not retrying.`);
      continue;
    }

    const checks = checkState(checkRuns);
    const verdict = latestReviewState(reviews);
    const humanVerdict = latestReviewState(reviews.filter((r) => !isBot(r.user)));
    const since = mergeableSince(checkRuns);
    const decision = decideMerge({ labels: pr.labels, draft: pr.draft, checks, verdict, humanVerdict, since, now: now() });

    if (!decision.merge) {
      console.log(`PR #${pr.number} (${decision.tier}-risk): ${decision.reason}`);
      continue;
    }

    try {
      // `sha` pins the merge to the head we judged: a push that races us makes
      // GitHub reject with 409 rather than merging code no verdict covered.
      await gh("PUT", `/repos/${repo}/pulls/${pr.number}/merge`, { sha, merge_method: "merge" });
    } catch (e) {
      // The API error text can be long; keep the comment readable but exact.
      const why = `${e.status ?? "error"}${e.message ? ` — ${e.message.slice(0, 300)}` : ""}`;
      const body = `${FAILED_MARKER(sha)}\n**Auto-merge failed and will not be retried for this commit.**\n\n- reason: \`${why}\`\n- risk tier: \`${decision.tier === "high" ? RISK_HIGH : "normal"}\`\n- check state: \`${checks}\`\n\nThe PR is left un-merged. Push a fix or merge it by hand.`;
      try {
        await gh("POST", `/repos/${repo}/issues/${pr.number}/comments`, { body });
      } catch (e2) {
        console.log(`PR #${pr.number}: merge failed (${why}) and the explanation comment failed too (${e2.status ?? e2.message}).`);
        continue;
      }
      console.log(`PR #${pr.number}: merge failed (${why}) — left un-merged, reason commented.`);
      continue;
    }

    try {
      await gh("POST", `/repos/${repo}/issues/${pr.number}/comments`, {
        body: recordComment({ ...decision, checks, verdict, humanVerdict }),
      });
    } catch (e) {
      console.log(`PR #${pr.number}: merged, but the record comment failed (${e.status ?? e.message}).`);
    }
    console.log(`PR #${pr.number}: ${decision.reason} — merged.`);
    merged++;
  }
  console.log(`auto-merge sweep complete: ${merged} PR(s) merged.`);
  return { merged };
}

// Auto-run only when executed directly, never on import (the test drives main()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
