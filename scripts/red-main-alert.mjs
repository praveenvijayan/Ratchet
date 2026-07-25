#!/usr/bin/env node
// red-main-alert.mjs — one alert when a workflow on `main` goes red. Both
// multi-week outages this repo has had (the 16-day CI break, the silent deploy
// failures) were one alert away from a one-day fix: nothing told a human. A
// scheduled pass reads the newest COMPLETED run of every workflow on `main` and
// keeps exactly one open alert per red workflow.
//
// Channels. The default channel is a GitHub issue labelled `red-main` carrying
// a `<!-- red-main-alert: <workflow> -->` marker: it needs no external service,
// and it is also the LEDGER — the only thing that makes "alert on the red
// transition, not per red run" and "resolve on recovery" possible from a
// stateless job — so it is always written first. A host webhook
// (`RED_MAIN_ALERT_WEBHOOK`) is the outbound delivery, fired only on the two
// transitions (red, resolved), never per run; a failed delivery is recorded as
// a comment on the ledger issue rather than dropped. Logic lives here so it is
// regression-tested off the network; the workflow is only trigger and env.
//
// Zero dependencies. Node 20+ (ESM).

import { fileURLToPath } from "node:url";
import { ghClient, paginate, resolveAuth } from "./gh-api.mjs";

export const ALERT_LABEL = "red-main";
export const alertMarker = (workflow) => `<!-- red-main-alert: ${workflow} -->`;

// Conclusions that mean the workflow is broken. `cancelled`, `skipped` and
// `neutral` are deliberate outcomes, not outages, and never raise an alert.
export const RED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

// The newest completed run per workflow, keyed by workflow name. The order is
// sorted explicitly rather than assumed: reading a stale run as "current" would
// resolve an alert while main is still red. Pure, so tested off the network.
export function newestRunPerWorkflow(runs) {
  const newest = new Map();
  const ordered = [...runs].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  for (const run of ordered) {
    if (run.head_branch !== "main") continue;
    const key = run.name || `workflow ${run.workflow_id}`;
    if (!newest.has(key)) newest.set(key, run);
  }
  return newest;
}

// Everything needed to start the fix without archaeology.
export function alertBody({ workflow, runUrl, job, runNumber }) {
  return [
    `Workflow **${workflow}** is failing on \`main\`.`,
    "",
    `- Run: ${runUrl}`,
    `- First failing job: ${job}`,
    `- Run number: #${runNumber}`,
    "",
    "This alert closes itself on the next green run — do not close it by hand.",
    "",
    alertMarker(workflow),
  ].join("\n");
}

// The first job of the run that failed. A jobs listing that 404s or rate-limits
// must never lose the alert, so it degrades to a named unknown, never a throw.
async function firstFailingJob(gh, repo, runId) {
  try {
    const { jobs = [] } = await gh("GET", `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`);
    const failed = jobs.find((j) => RED_CONCLUSIONS.has(j.conclusion));
    return failed ? failed.name : "none reported (the run failed before any job ran)";
  } catch {
    return "unknown — the run's job list could not be read";
  }
}

// Deliver one transition to the host's webhook. Returns an error string on any
// non-2xx or network error, null on success; the caller records the failure.
async function deliverWebhook(url, payload, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok ? null : `webhook responded ${res.status}`;
  } catch (e) {
    return `webhook request failed: ${e.message}`;
  }
}

// Create the alert label once per repo, exactly as conflicted-prs does: an
// already-existing label is normal, anything else is a failure worth surfacing.
async function ensureLabel(gh, repo) {
  try {
    await gh("GET", `/repos/${repo}/labels/${ALERT_LABEL}`);
    return;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  try {
    await gh("POST", `/repos/${repo}/labels`, {
      name: ALERT_LABEL,
      color: "b60205",
      description: "A workflow is failing on main",
    });
  } catch (e) {
    if (e.status !== 422) throw e;
  }
}

export async function main({ auth = resolveAuth, fetchImpl = fetch, env = process.env } = {}) {
  const { token, repo } = auth();
  const gh = ghClient(token, { fetchImpl });
  const webhook = (env.RED_MAIN_ALERT_WEBHOOK || "").trim();

  await ensureLabel(gh, repo);

  const { workflow_runs: runs = [] } = await gh("GET", `/repos/${repo}/actions/runs?branch=main&status=completed&per_page=100`);
  const current = newestRunPerWorkflow(runs);
  // The marker, not the title, is the link — editing a title cannot fork an alert.
  const open = await paginate(gh, `/repos/${repo}/issues?state=open&labels=${ALERT_LABEL}`);
  const alertFor = new Map();
  for (const issue of open) {
    for (const workflow of current.keys()) {
      if ((issue.body || "").includes(alertMarker(workflow))) alertFor.set(workflow, issue);
    }
  }

  // The fallback is written where the alert lives, not only in a log line.
  const noteFallback = async (number, reason) => {
    console.log(`webhook delivery failed (${reason}) — alert kept in the default channel, issue #${number}`);
    await gh("POST", `/repos/${repo}/issues/${number}/comments`, {
      body: `Webhook delivery failed (${reason}). This alert stayed in the default channel rather than being dropped.`,
    });
  };

  let opened = 0, updated = 0, resolved = 0;
  for (const [workflow, run] of current) {
    const existing = alertFor.get(workflow);

    if (!RED_CONCLUSIONS.has(run.conclusion)) {
      if (!existing) continue;              // green and quiet — nothing to do
      await gh("POST", `/repos/${repo}/issues/${existing.number}/comments`, {
        body: `Resolved: **${workflow}** is green again on \`main\` (${run.html_url}).`,
      });
      await gh("PATCH", `/repos/${repo}/issues/${existing.number}`, { state: "closed", state_reason: "completed" });
      console.log(`${workflow}: recovered — alert #${existing.number} resolved.`);
      resolved++;
      if (webhook) {
        const failure = await deliverWebhook(webhook, { event: "resolved", workflow, run_url: run.html_url, issue: existing.number }, { fetchImpl });
        if (failure) await noteFallback(existing.number, failure);
      }
      continue;
    }

    const body = alertBody({ workflow, runUrl: run.html_url, job: await firstFailingJob(gh, repo, run.id), runNumber: run.run_number });

    // Still red on a later run: refresh the one open alert. No second issue and
    // no second delivery — the alert fires on the transition, not per red run.
    if (existing) {
      if ((existing.body || "") !== body) {
        await gh("PATCH", `/repos/${repo}/issues/${existing.number}`, { body });
        console.log(`${workflow}: still red — alert #${existing.number} updated to run #${run.run_number}.`);
        updated++;
      } else {
        console.log(`${workflow}: still red — alert #${existing.number} already current, no change.`);
      }
      continue;
    }

    const created = await gh("POST", `/repos/${repo}/issues`, {
      title: `main is red: ${workflow} is failing`,
      body,
      labels: [ALERT_LABEL],
    });
    console.log(`${workflow}: went red — alert #${created.number} opened.`);
    opened++;
    if (webhook) {
      const failure = await deliverWebhook(webhook, { event: "red", workflow, run_url: run.html_url, issue: created.number }, { fetchImpl });
      if (failure) await noteFallback(created.number, failure);
    }
  }

  console.log(`red-main-alert pass complete: ${opened} opened, ${updated} updated, ${resolved} resolved.`);
  return { opened, updated, resolved };
}

// Auto-run only when executed directly, never on import (the test drives main()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
