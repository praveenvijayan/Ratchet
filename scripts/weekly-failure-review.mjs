#!/usr/bin/env node
// weekly-failure-review.mjs — the repeat-failure scan, on a schedule.
//
// Scanning a week's fix-PRs for repeat failure classes is this project's best
// improvement mechanism (it produced the identity and config gates), but while
// it was ad hoc it was also skippable. This job runs it weekly: collect the
// merged fix/rework PRs, group them by failure class, publish one report.
//
// Channel. The report is an issue carrying a `<!-- weekly-failure-review: <week>
// -->` marker: GitHub alone, no external service, and the marker (not the title)
// is the identity, so a re-run updates the week's report instead of forking it.
// Every outcome goes to that one channel — a week with no fix-PRs publishes a
// report saying so, and a failure (unreadable config, API error) publishes a
// report naming the error. Silence is therefore never ambiguous between "nothing
// failed" and "the job broke".
//
// Zero dependencies. Node 20+ (ESM).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ghClient, paginate, resolveAuth } from "./gh-api.mjs";

export const REVIEW_LABEL = "failure-review";
export const reviewMarker = (week) => `<!-- weekly-failure-review: ${week} -->`;

// The framework's own conventions, used when the host configures none: a
// conventional-commit `fix:`/`revert:`/`hotfix:` subject, or the hotfix label.
export const DEFAULT_TITLE_PATTERN = "^(fix|revert|hotfix)(\\(.+\\))?!?:";
export const DEFAULT_LABELS = ["hotfix"];

// Host config, from the `## Weekly failure-pattern review` section of GATES.md.
// Absent file -> a config error the caller publishes; absent section -> the
// defaults above, recorded in the report. An unusable section (bad regex, or
// every selector emptied) is an error too: it would silently select nothing,
// which reads exactly like a quiet week.
export function readConfig(text) {
  if (text == null) return { error: "GATES.md could not be read, so no fix-PR convention is configured" };
  const has = /^##\s+Weekly failure-pattern review\s*$/m.test(text);
  const rawPattern = text.match(/^-\s*fix_pr_title_pattern:\s*(.+)$/m)?.[1].trim();
  const rawLabels = text.match(/^-\s*fix_pr_labels:\s*\[(.*)\]$/m)?.[1];
  const pattern = has && rawPattern !== undefined ? rawPattern : DEFAULT_TITLE_PATTERN;
  const labels = has && rawLabels !== undefined
    ? rawLabels.split(",").map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_LABELS];
  const usingPattern = pattern.toLowerCase() !== "none" ? pattern : null;
  if (!usingPattern && labels.length === 0) return { error: "every fix-PR selector in GATES.md is empty, so no PR could ever be collected" };
  let regex = null;
  if (usingPattern) {
    try {
      regex = new RegExp(usingPattern, "i");
    } catch (e) {
      return { error: `fix_pr_title_pattern in GATES.md is not a valid regular expression (${e.message})` };
    }
  }
  return { regex, labels, defaults: !has };
}

// The ISO week that just ended: Monday 00:00 UTC through the next Monday. Any
// run inside the following week — the Monday cron, or a manual dispatch on the
// Thursday — reports on the same window, so the week id stays one per week.
export function lastWeek(now) {
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - ((now.getUTCDay() + 6) % 7) * 86400000;
  const start = new Date(monday - 7 * 86400000);
  return { start, end: new Date(monday), id: start.toISOString().slice(0, 10) };
}

export const isFixPr = (pr, config) =>
  (config.regex ? config.regex.test(pr.title || "") : false) ||
  (pr.labels || []).some((l) => config.labels.includes(l.name));

// The failure class: the conventional-commit scope when the author wrote one
// (`fix(gates): …` -> `gates`), else the PR's own topic label, else a named
// bucket — an unclassifiable PR is still listed, never dropped from the count.
export function failureClass(pr) {
  const scope = (pr.title || "").match(/^\s*\w+\(([^)]+)\)!?:/);
  if (scope) return scope[1].trim();
  const label = (pr.labels || []).map((l) => l.name).find((n) => !/^(state|priority|risk):/.test(n));
  return label || "unclassified";
}

export function groupByClass(prs) {
  const groups = new Map();
  for (const pr of prs) {
    const key = failureClass(pr);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pr);
  }
  // Repeat classes first — the whole point of the scan is what recurred.
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
}

const CONTRACT = "**Your 30 minutes:** read the groups above, and for each class that repeats and is worth a rule, file a `plan/*.md` through the normal planning protocol. This job only surfaces patterns — the planning protocol is what consumes them.";

export function reportBody({ week, window, groups, count, previous, defaults, error }) {
  const lines = [];
  if (error) {
    lines.push(`This week's review could **not** be produced: ${error}.`, "", "No pattern data was collected. Fix the cause and re-run the workflow (`workflow_dispatch`) to replace this report.", "");
  } else if (count === 0) {
    lines.push(`No fix or rework PRs were merged between ${window}. The scan ran and found nothing — this is a quiet week, not a broken job.`, "");
  } else {
    lines.push(`${count} fix/rework PRs merged between ${window}, grouped by failure class.`, "");
    for (const [name, prs] of groups) {
      lines.push(`## ${name} — ${prs.length} PR${prs.length === 1 ? "" : "s"}`);
      for (const pr of prs) lines.push(`- #${pr.number} ${pr.title} — ${pr.html_url}`);
      lines.push("");
    }
  }
  if (defaults) lines.push("_Collected with the framework's default fix-PR conventions; add a `## Weekly failure-pattern review` section to `GATES.md` to configure your own._", "");
  lines.push(CONTRACT, "", previous ? `Previous report: #${previous}` : "This is the first weekly report.", "", reviewMarker(week));
  return lines.join("\n");
}

async function ensureLabel(gh, repo) {
  try {
    await gh("GET", `/repos/${repo}/labels/${REVIEW_LABEL}`);
    return;                                          // created on an earlier week
  } catch (e) { if (e.status !== 404) throw e; }
  try {
    await gh("POST", `/repos/${repo}/labels`, { name: REVIEW_LABEL, color: "1d76db", description: "Weekly failure-pattern review report" });
  } catch (e) { if (e.status !== 422) throw e; }      // 422: a racing run made it
}

// Merged PRs whose merge landed inside the window. Closed-unmerged PRs never
// count: nothing shipped, so there is no failure class to learn from. The scan
// is bounded to the 300 most recently updated closed PRs — far more than a week
// of merges, and it keeps one busy repo from paging its whole history.
async function mergedInWindow(gh, repo, { start, end }) {
  const prs = await paginate(gh, `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, { cap: 300 });
  return prs.filter((pr) => pr.merged_at && new Date(pr.merged_at) >= start && new Date(pr.merged_at) < end);
}

export async function main({ auth = resolveAuth, fetchImpl = fetch, env = process.env, now = new Date(), readGates = () => (existsSync("GATES.md") ? readFileSync("GATES.md", "utf8") : null) } = {}) {
  const { token, repo } = auth();
  const gh = ghClient(token, { fetchImpl });
  const week = lastWeek(now);
  const window = `${week.id} and ${week.end.toISOString().slice(0, 10)} (UTC)`;

  let config = { error: null };
  let matched = [];
  let error = null;
  try {
    config = readConfig(readGates());
    if (config.error) error = config.error;
    else matched = (await mergedInWindow(gh, repo, week)).filter((pr) => isFixPr(pr, config));
  } catch (e) {
    error = `the GitHub API call failed (${e.message})`;
  }

  // The report channel is also the archive, so the previous week is read from
  // it — that back-link is what makes the run of reports walkable.
  const open = await paginate(gh, `/repos/${repo}/issues?state=all&labels=${REVIEW_LABEL}`, { cap: 200 });
  const existing = open.find((i) => (i.body || "").includes(reviewMarker(week.id)));
  const previous = open.filter((i) => !(i.body || "").includes(reviewMarker(week.id))).sort((a, b) => b.number - a.number)[0];

  const body = reportBody({ week: week.id, window, groups: groupByClass(matched), count: matched.length, previous: previous?.number, defaults: config.defaults, error });
  const title = `Weekly failure-pattern review — week of ${week.id}${error ? " (failed)" : ""}`;

  await ensureLabel(gh, repo);
  let number;
  if (existing) {
    await gh("PATCH", `/repos/${repo}/issues/${existing.number}`, { title, body });
    number = existing.number;
    console.log(`weekly-failure-review: week ${week.id} report updated (#${number}).`);
  } else {
    const created = await gh("POST", `/repos/${repo}/issues`, { title, body, labels: [REVIEW_LABEL] });
    number = created.number;
    console.log(`weekly-failure-review: week ${week.id} report published (#${number}).`);
    // Forward link, so this week's report is reachable from last week's.
    if (previous) await gh("POST", `/repos/${repo}/issues/${previous.number}/comments`, { body: `Next report: #${number} (week of ${week.id}).` });
  }
  return { week: week.id, issue: number, prs: matched.length, classes: groupByClass(matched).length, error };
}

// Auto-run only when executed directly, never on import (the test drives main()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`weekly-failure-review could not publish a report: ${e.message}`);
    process.exit(1);
  });
}
