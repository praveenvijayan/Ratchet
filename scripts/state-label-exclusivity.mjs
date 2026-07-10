#!/usr/bin/env node
// state-label-exclusivity.mjs — orchestration for the state-label-exclusivity
// workflow. State labels are a state machine: an open issue must carry at most
// one `state:*` label at a time. The claim/rework instructions add a new state
// label symmetrically with removing the previous one, but a single missed
// removal used to survive every later flip permanently (observed on #181:
// state:ready lingered next to state:in-review, so the pick step saw an
// in-review issue as pickable). This closes the loop GitHub-side: when a
// `state:*` label is added to an issue that already carries a different one, the
// newest label wins and the stale one is stripped, with no agent discipline
// load-bearing — the same labeled-event pattern as unblock-dependents.
//
// Non-state labels (`priority:*`, `herd`, anything else) are never touched: the
// rewrite keeps every non-state label and only ever drops the *other* state
// labels, never the one just added, so an issue is never left with zero state
// labels. All logic lives here so it can be regression-tested against an
// in-memory API (see state-label-exclusivity.test.mjs); the workflow YAML is
// only the trigger. Zero dependencies. Node 20+ (ESM).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

const labelNames = (labels) => labels.map((l) => (typeof l === "string" ? l : l.name));
const isState = (name) => name.startsWith("state:");

// The label just added and the issue it landed on. In Actions both come from the
// `issues: labeled` payload at GITHUB_EVENT_PATH; a test or manual run can pass
// ADDED_LABEL and ISSUE_NUMBER directly.
function trigger() {
  const env = { label: process.env.ADDED_LABEL, issue: process.env.ISSUE_NUMBER };
  if (env.label && env.issue) return { addedLabel: env.label, issue: Number(env.issue) };
  const path = process.env.GITHUB_EVENT_PATH;
  if (path && existsSync(path)) {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    const addedLabel = payload.label?.name ?? env.label;
    const issue = payload.issue?.number ?? (env.issue && Number(env.issue));
    if (addedLabel && issue) return { addedLabel, issue: Number(issue) };
  }
  throw new Error(
    "No labeled event to react to. Set ADDED_LABEL and ISSUE_NUMBER, or provide GITHUB_EVENT_PATH with label.name and issue.number.",
  );
}

export async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    throw new Error("Missing token or repo. Set GITHUB_TOKEN (or GITHUB_PAT) and GITHUB_REPOSITORY.");
  }
  const gh = ghClient(token);
  const { addedLabel, issue } = trigger();

  // Only a state label can create a duplicate-state situation. A non-state label
  // (priority:*, herd, …) never triggers a removal — enforcement leaves it alone.
  if (!isState(addedLabel)) {
    console.log(`#${issue}: added label "${addedLabel}" is not a state label; nothing to enforce.`);
    return { changed: false, removed: [] };
  }

  // Every failure past this point names the issue, so a run never fails silently
  // or anonymously — the dual state must be visible in the logs.
  try {
    // Re-read the live labels: the payload is a snapshot and a concurrent flip
    // may already have changed things. The newest label is the truth we enforce.
    const current = await gh("GET", `/repos/${repo}/issues/${issue}`);
    const names = labelNames(current.labels || []);

    // If the added label is already gone (a later transition removed it), there
    // is nothing for us to enforce — never re-add a label the issue shed.
    if (!names.includes(addedLabel)) {
      console.log(`#${issue}: added label "${addedLabel}" no longer present; skipping.`);
      return { changed: false, removed: [] };
    }

    const stateLabels = names.filter(isState);
    const stale = stateLabels.filter((l) => l !== addedLabel);
    if (stale.length === 0) {
      console.log(`#${issue}: "${addedLabel}" is the only state label; already exclusive.`);
      return { changed: false, removed: [] };
    }

    // Keep every non-state label plus only the newest state label. This both
    // enforces exactly-one-state and guarantees the issue never drops to zero
    // state labels, and it can never touch a non-state label.
    const kept = names.filter((l) => !isState(l) || l === addedLabel);
    await gh("PUT", `/repos/${repo}/issues/${issue}/labels`, { labels: kept });
    console.log(`#${issue}: kept "${addedLabel}", removed stale state label(s): ${stale.join(", ")}.`);
    return { changed: true, removed: stale };
  } catch (e) {
    throw new Error(`state-label-exclusivity failed for #${issue}: ${e.message}`);
  }
}

// Auto-run only when executed directly, never on import (the test drives main()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
