#!/usr/bin/env node
// weekly-failure-review.test.mjs — one test per acceptance criterion of issue
// #483 (plan 0204-weekly-failure-pattern-review): the repeat-failure scan runs
// on a schedule, publishes one grouped report per week, is never silent, and
// states the human's contract. Drives main() against an in-memory GitHub API.
// Zero dependencies. Run: node scripts/weekly-failure-review.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { main, REVIEW_LABEL, reviewMarker } from "./weekly-failure-review.mjs";

const auth = () => ({ token: "test-token", repo: "o/r" });
const respond = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
const NOW = new Date("2026-07-27T07:00:00Z");           // Monday; window = 07-20..07-27
const WEEK = "2026-07-20";
const GATES = "## Weekly failure-pattern review\n\n- fix_pr_labels: [hotfix]\n- fix_pr_title_pattern: ^(fix|revert|hotfix)(\\(.+\\))?!?:\n";

const pr = (over = {}) => ({
  number: 10, title: "fix(gates): stop stripping the config", html_url: "https://github.com/o/r/pull/10",
  merged_at: "2026-07-22T10:00:00Z", labels: [], ...over,
});

// In-memory GitHub. `prs` seeds the closed-PR listing, `issues` the report
// ledger, `failing` forces the PR listing to throw. An unexpected request throws,
// so an extra silent API call cannot pass unnoticed.
function makeApi({ prs = [], issues = [], failing = null } = {}) {
  const store = new Map(issues.map((i) => [i.number, i]));
  const created = [], comments = [], patches = [];
  let next = 700;
  const fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    const { pathname, searchParams } = new URL(url);
    const page = Number(searchParams.get("page"));
    const one = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)$/);
    const onComments = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments$/);
    if (method === "GET" && pathname === `/repos/o/r/labels/${REVIEW_LABEL}`) return respond({ name: REVIEW_LABEL });
    if (method === "GET" && pathname === "/repos/o/r/pulls") {
      if (failing) throw new Error(failing);
      return respond(page === 1 ? prs : []);
    }
    if (method === "GET" && pathname === "/repos/o/r/issues") return respond(page === 1 ? [...store.values()] : []);
    if (method === "POST" && pathname === "/repos/o/r/issues") {
      const issue = { number: next++, state: "open", ...body };
      store.set(issue.number, issue);
      created.push(issue);
      return respond(issue, 201);
    }
    if (method === "PATCH" && one) {
      const issue = store.get(Number(one[1]));
      Object.assign(issue, body);
      patches.push({ issue: issue.number, ...body });
      return respond(issue);
    }
    if (method === "POST" && onComments) {
      comments.push({ issue: Number(onComments[1]), body: body.body });
      return respond({}, 201);
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
  return { fetch, store, created, comments, patches };
}

const run = (api, gates = GATES) => main({ auth, fetchImpl: api.fetch, env: {}, now: NOW, readGates: () => gates });

// --- Criterion 1: a scheduled weekly job collects the week's merged fix/rework
// PRs by the host's configured conventions and groups them by failure class,
// each group linking its member PRs.
{
  const api = makeApi({
    prs: [
      pr(),
      pr({ number: 11, title: "fix(gates): base config leaked again", html_url: "https://github.com/o/r/pull/11" }),
      pr({ number: 12, title: "revert: bad herd split", html_url: "https://github.com/o/r/pull/12", labels: [{ name: "herd" }, { name: "priority:high" }] }),
      pr({ number: 13, title: "chore: bump version" }),                                    // not a fix PR
      pr({ number: 14, title: "fix(docs): typo", merged_at: "2026-07-01T00:00:00Z" }),      // outside the window
      pr({ number: 15, title: "fix(docs): never merged", merged_at: null }),                // closed, not merged
      pr({ number: 16, title: "chore: cleanup", labels: [{ name: "hotfix" }] }),            // selected by label
    ],
  });
  const result = await run(api);
  assert.equal(result.prs, 4, `only the window's merged fix/rework PRs count, got ${result.prs}`);
  const body = api.created[0].body;
  assert.match(body, /## gates — 2 PRs/, `repeat classes must be grouped and counted, got:\n${body}`);
  assert.ok(body.includes("https://github.com/o/r/pull/11"), `each group must link its member PRs, got:\n${body}`);
  assert.match(body, /## herd — 1 PR/, `a scope-less fix PR must fall back to its topic label, got:\n${body}`);
  assert.ok(!body.includes("#13") && !body.includes("#14") && !body.includes("#15"), `non-fix, out-of-window and unmerged PRs must not appear, got:\n${body}`);
  assert.ok(body.indexOf("## gates") < body.indexOf("## herd"), "repeat classes must sort ahead of one-offs");
  // Host-configurable: a different convention selects a different set.
  const other = makeApi({ prs: [pr(), pr({ number: 17, title: "regression: config leak", html_url: "https://github.com/o/r/pull/17" })] });
  const narrowed = await run(other, "## Weekly failure-pattern review\n\n- fix_pr_labels: []\n- fix_pr_title_pattern: ^regression:\n");
  assert.equal(narrowed.prs, 1, "the host's own convention must decide what counts as a fix PR");
  assert.ok(other.created[0].body.includes("#17"), `the host-configured pattern must select its own PRs, got:\n${other.created[0].body}`);
  // The job is scheduled, not ad hoc: a weekly cron, plus manual dispatch.
  const workflow = readFileSync(new URL("../.github/workflows/weekly-failure-review.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron:\s*"[^"]*\*\s+\*\s+[0-6]"/, `the review must run on a weekly cron, got:\n${workflow}`);
  assert.match(workflow, /workflow_dispatch/, "the review must also be runnable on demand");
}

// --- Criterion 2: the report is durable and reviewable, one per week, and the
// run of reports is walkable from the previous week's.
{
  const previous = { number: 600, state: "closed", title: "Weekly failure-pattern review — week of 2026-07-13", body: `old\n\n${reviewMarker("2026-07-13")}`, labels: [{ name: REVIEW_LABEL }] };
  const api = makeApi({ prs: [pr()], issues: [previous] });
  const result = await run(api);
  assert.equal(api.created.length, 1, "the week's report must be published as its own issue");
  assert.ok(api.created[0].labels.includes(REVIEW_LABEL), `the report must carry the ${REVIEW_LABEL} label, got: ${api.created[0].labels}`);
  assert.ok(api.created[0].body.includes(reviewMarker(WEEK)), "the report must carry its week marker");
  assert.ok(api.created[0].body.includes("Previous report: #600"), `the report must link back to the previous week, got:\n${api.created[0].body}`);
  const forward = api.comments.find((c) => c.issue === 600);
  assert.ok(forward && forward.body.includes(`#${result.issue}`), `last week's report must lead to this week's, got: ${JSON.stringify(api.comments)}`);
  // One per week: a second run in the same week updates the report, never forks it.
  const second = await run(api);
  assert.equal(api.created.length, 1, "a re-run in the same week must not publish a second report");
  assert.equal(second.issue, result.issue, "the week's report is identified by its marker, not its title");
  assert.ok(api.patches.some((p) => p.issue === result.issue), "the re-run must refresh the existing report");
}

// --- Criterion 3: a week with zero fix-PRs still publishes a report saying so.
{
  const api = makeApi({ prs: [pr({ number: 20, title: "feat: new gate" })] });
  const result = await run(api);
  assert.equal(result.prs, 0, "no fix PRs merged this week");
  assert.equal(api.created.length, 1, "a quiet week must still publish a report");
  assert.match(api.created[0].body, /No fix or rework PRs were merged/, `the report must say the week was quiet, got:\n${api.created[0].body}`);
  assert.match(api.created[0].body, /not a broken job/, "the report must distinguish a quiet week from a broken job");
}

// --- Criterion 4: failures are published in the same channel, never a silently
// skipped week — both an API error and missing config.
{
  const api = makeApi({ failing: "rate limited" });
  const result = await run(api);
  assert.ok(result.error, "an API failure must be reported, not swallowed");
  assert.equal(api.created.length, 1, "an API failure must still publish a report in the same channel");
  assert.match(api.created[0].title, /failed/, `the failed week's report must be visible as failed, got: ${api.created[0].title}`);
  assert.match(api.created[0].body, /rate limited/, `the report must name the error, got:\n${api.created[0].body}`);
  const noConfig = makeApi({ prs: [pr()] });
  await run(noConfig, null);
  assert.match(noConfig.created[0].body, /no fix-PR convention is configured/, `missing config must publish in the same channel, got:\n${noConfig.created[0].body}`);
  const badRegex = makeApi({ prs: [pr()] });
  await run(badRegex, "## Weekly failure-pattern review\n\n- fix_pr_labels: []\n- fix_pr_title_pattern: ^(unclosed\n");
  assert.match(badRegex.created[0].body, /not a valid regular expression/, `unusable config must publish in the same channel, got:\n${badRegex.created[0].body}`);
}

// --- Criterion 5: the human's 30-minute contract is stated — in the docs, and
// on every report so the reader never has to go looking for it.
{
  const docs = readFileSync(new URL("../DOCS.md", import.meta.url), "utf8");
  assert.match(docs, /30 minutes/, "DOCS.md must state the human's 30-minute contract");
  assert.match(docs, /weekly-failure-review/, "DOCS.md must document the weekly review job");
  const api = makeApi({ prs: [pr()] });
  await run(api);
  assert.match(api.created[0].body, /Your 30 minutes/, `the report must restate the contract, got:\n${api.created[0].body}`);
  assert.match(api.created[0].body, /plan\/\*\.md/, "the contract must route repeat classes into the planning protocol");
}

console.log("PASS weekly-failure-review.test.mjs (5 criteria)");
