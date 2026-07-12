#!/usr/bin/env node
// review-verdict.mjs — orchestration for the review-verdict workflow.
// When a Request Changes review is submitted on an agent PR, flip the mapped
// issue from state:in-review to state:changes-requested so the label reflects
// the review verdict immediately — no agent polling needed. APPROVED/COMMENTED
// reviews change no labels; a PR mapping to no issue is a logged no-op; a
// label-update API failure fails the run visibly, naming the issue. The flip
// back to state:in-review after rework stays with the agent (AGENTS.md step 6)
// — this workflow is the single owner of the review-time flip.
//
// Tested off the network against an in-memory API (review-verdict.test.mjs).
// Zero dependencies. Node 20+ (ESM).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ghClient, resolveAuth } from "./gh-api.mjs";

const labelNames = (labels) => labels.map((l) => (typeof l === "string" ? l : l.name));

// Read the pull_request_review event payload. In Actions it is at
// GITHUB_EVENT_PATH; a test or manual run can pass REVIEW_EVENT as JSON.
function reviewEvent() {
  if (process.env.REVIEW_EVENT) return JSON.parse(process.env.REVIEW_EVENT);
  const path = process.env.GITHUB_EVENT_PATH;
  if (path && existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  throw new Error(
    "No review event to react to. Set REVIEW_EVENT, or provide GITHUB_EVENT_PATH with the pull_request_review payload.",
  );
}

// Map a PR to an issue number: prefer the agent/issue-<N> head branch, then
// fall back to a `Closes #<N>` marker in the PR body. Null when neither maps.
export function mapIssueNumber(headRef, body) {
  const branch = headRef?.match(/agent\/issue-(\d+)/);
  if (branch) return Number(branch[1]);
  const closes = [...(body || "").matchAll(/Closes #(\d+)/g)].map((m) => Number(m[1]));
  if (closes.length) return closes[0];
  return null;
}

export async function main({ auth = resolveAuth, fetchImpl } = {}) {
  const { token, repo } = auth();
  const gh = ghClient(token, { fetchImpl });
  const event = reviewEvent();
  const state = event.review?.state;
  const pr = event.pull_request;

  // Only a Request Changes verdict flips the label; APPROVED/COMMENTED are no-ops.
  if (state !== "changes_requested") {
    console.log(`review state '${state}' on PR #${pr?.number ?? "?"} — no label change.`);
    return { flipped: false, reason: "non-request-changes" };
  }

  const issueNumber = mapIssueNumber(pr?.head?.ref, pr?.body);
  if (issueNumber == null) {
    console.log(`PR #${pr?.number ?? "?"} maps to no issue — skipping.`);
    return { flipped: false, reason: "no-issue" };
  }

  const issue = await gh("GET", `/repos/${repo}/issues/${issueNumber}`);
  const labels = labelNames(issue.labels || []);
  const has = (name) => labels.includes(name);

  // Idempotent: already changes-requested — leave it, succeed.
  if (has("state:changes-requested")) {
    console.log(`issue #${issueNumber} already state:changes-requested — no change.`);
    return { flipped: false, reason: "already-changes-requested", issue: issueNumber };
  }

  // Only flip from in-review. Any other state is left untouched.
  if (!has("state:in-review")) {
    const cur = labels.filter((l) => l.startsWith("state:")).join(", ") || "none";
    console.log(`issue #${issueNumber} is not state:in-review (${cur}) — no change.`);
    return { flipped: false, reason: "not-in-review", issue: issueNumber };
  }

  const kept = labels.filter((l) => l !== "state:in-review");
  kept.push("state:changes-requested");
  try {
    await gh("PUT", `/repos/${repo}/issues/${issueNumber}/labels`, { labels: kept });
  } catch (e) {
    throw new Error(`label update for issue #${issueNumber} failed: ${e.status ?? e.message}`);
  }
  console.log(`flipped issue #${issueNumber} from state:in-review to state:changes-requested.`);
  return { flipped: true, reason: "flipped", issue: issueNumber };
}

// Auto-run only when executed directly, never on import (the test drives main()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
