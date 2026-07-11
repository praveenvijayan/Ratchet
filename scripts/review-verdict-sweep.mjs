#!/usr/bin/env node
// review-verdict-sweep.mjs — scheduled reconciliation for the review-verdict
// label flip. The event-driven review-verdict workflow is the fast path, but
// GitHub silently skips pull_request_review runs on conflicted PRs
// (mergeable_state: dirty) and an Actions outage or future gap would likewise
// strand an issue in state:in-review with a rejection the board never showed.
// This sweep walks every open PR, reads its latest review, and flips the mapped
// issue when the fast path missed it — the same self-healing pattern
// sweep-stale-claims and unblock-dependents use. Reuses mapIssueNumber from
// review-verdict.mjs so PR -> issue mapping stays defined in one place.
// Decision logic here is regression-tested off the network; the workflow is
// only its trigger and env. Zero dependencies. Node 20+ (ESM).

import { fileURLToPath } from "node:url";
import { mapIssueNumber } from "./review-verdict.mjs";

const API = "https://api.github.com";

function ghClient(token) {
  return async function gh(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  };
}

async function paginate(gh, path) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await gh("GET", `${path}${sep}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

const labelNames = (labels) => labels.map((l) => (typeof l === "string" ? l : l.name));

// The state of the most recent review on a PR, or null when there are none.
// "Latest" is by submitted_at; the API returns reviews chronologically but this
// is robust to any reordering. Only CHANGES_REQUESTED flips — APPROVED and
// COMMENTED are no-ops, matching the event-driven review-verdict's logic.
export function latestReviewState(reviews) {
  if (!reviews || !reviews.length) return null;
  const sorted = [...reviews].sort(
    (a, b) =>
      new Date(b.submitted_at || b.updated_at || b.created_at || 0) -
      new Date(a.submitted_at || a.updated_at || a.created_at || 0),
  );
  return sorted[0]?.state ?? null;
}

// Decide whether the sweep flips this issue. Pure — all API data is already
// fetched by the orchestration, so the test drives it without the network.
//   input.labels             — the mapped issue's current label names
//   input.latestReviewState  — "CHANGES_REQUESTED" | "APPROVED" | "COMMENTED" | null
// Returns { flip: false, reason } to leave the issue untouched, or
// { flip: true, reason } to swap state:in-review for state:changes-requested.
export function decideReconcile({ labels = [], latestReviewState: state }) {
  if (state !== "CHANGES_REQUESTED") {
    return { flip: false, reason: `latest review '${state}' — no label change` };
  }
  if (labels.includes("state:changes-requested")) {
    return { flip: false, reason: "already state:changes-requested — no change" };
  }
  if (!labels.includes("state:in-review")) {
    return { flip: false, reason: "not state:in-review — no change" };
  }
  return { flip: true, reason: "flipped state:in-review -> state:changes-requested" };
}

// --- orchestration: the sweep the workflow runs -----------------------------
// Everything above is the pure decision core (unit-tested without the network).
// Below is the thin driver: it lists open PRs, reads each one's latest review,
// and flips the mapped issue when the fast path missed it. A GitHub API failure
// on one PR is logged and never aborts the remaining PRs.

export async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    throw new Error("Missing token or repo. Set GITHUB_TOKEN (or GITHUB_PAT) and GITHUB_REPOSITORY.");
  }
  const gh = ghClient(token);

  let prs;
  try {
    prs = await paginate(gh, `/repos/${repo}/pulls?state=open`);
  } catch (e) {
    throw new Error(`could not list open PRs: ${e.status ?? e.message}`);
  }

  let flipped = 0;
  for (const pr of prs) {
    const issueNumber = mapIssueNumber(pr.head?.ref, pr.body);
    if (issueNumber == null) {
      console.log(`PR #${pr.number} maps to no issue — skipping.`);
      continue;
    }

    let reviews;
    try {
      reviews = await paginate(gh, `/repos/${repo}/pulls/${pr.number}/reviews`);
    } catch (e) {
      console.log(`PR #${pr.number}: could not read reviews (${e.status ?? e.message}) — skipping.`);
      continue;
    }
    const state = latestReviewState(reviews);

    let issue;
    try {
      issue = await gh("GET", `/repos/${repo}/issues/${issueNumber}`);
    } catch (e) {
      console.log(`PR #${pr.number} -> issue #${issueNumber}: could not read issue (${e.status ?? e.message}) — skipping.`);
      continue;
    }

    const decision = decideReconcile({
      labels: labelNames(issue.labels || []),
      latestReviewState: state,
    });
    if (!decision.flip) {
      console.log(`PR #${pr.number} -> issue #${issueNumber}: ${decision.reason}`);
      continue;
    }

    // Re-read at write time: the first read may be stale by the time labels are
    // written, so re-checking prevents clobbering a concurrent transition (an
    // agent reworking and moving the issue back to state:in-review, or another
    // sweep pass). Idempotent — if the issue is no longer state:in-review, leave
    // it.
    let fresh;
    try {
      fresh = await gh("GET", `/repos/${repo}/issues/${issueNumber}`);
    } catch (e) {
      console.log(`issue #${issueNumber}: could not re-read before write (${e.status ?? e.message}) — skipping.`);
      continue;
    }
    const freshLabels = labelNames(fresh.labels || []);
    if (freshLabels.includes("state:changes-requested") || !freshLabels.includes("state:in-review")) {
      console.log(`issue #${issueNumber}: state changed since first read — skipping.`);
      continue;
    }

    const kept = freshLabels.filter((l) => l !== "state:in-review");
    kept.push("state:changes-requested");
    try {
      await gh("PUT", `/repos/${repo}/issues/${issueNumber}/labels`, { labels: kept });
    } catch (e) {
      console.log(`issue #${issueNumber}: label update failed (${e.status ?? e.message}) — skipping.`);
      continue;
    }
    console.log(`issue #${issueNumber}: ${decision.reason}`);
    flipped++;
  }
  console.log(`review-verdict sweep complete: ${flipped} issue(s) flipped.`);
  return { flipped };
}

// Auto-run only when executed directly, never on import (the test drives main()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
