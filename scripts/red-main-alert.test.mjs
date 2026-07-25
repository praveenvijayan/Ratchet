#!/usr/bin/env node
// red-main-alert.test.mjs — one test per acceptance criterion of issue #482
// (plan 0203-red-main-alert): a scheduled pass alerts on a workflow that goes
// red on `main`, keeps one open alert per red workflow, and resolves it on
// recovery. Drives main() against an in-memory GitHub API and host webhook.
// Zero dependencies. Run: node scripts/red-main-alert.test.mjs

import assert from "node:assert/strict";

import { main, ALERT_LABEL, alertMarker } from "./red-main-alert.mjs";

const auth = () => ({ token: "test-token", repo: "o/r" });
const respond = (data, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data,
  text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
});

const redRun = (over = {}) => ({
  id: 1, name: "pr-gates", head_branch: "main", conclusion: "failure",
  html_url: "https://github.com/o/r/actions/runs/1", run_number: 7,
  created_at: "2026-07-01T00:00:00Z", ...over,
});

// In-memory GitHub plus the host webhook. `jobs` maps run id -> job list,
// `issues` seeds the alert ledger, `webhook` selects the delivery outcome, and
// every write is recorded. An unexpected request throws, so a silent extra API
// call cannot pass unnoticed.
function makeApi({ runs = [], jobs = {}, issues = [], webhook = "ok" } = {}) {
  const store = new Map(issues.map((i) => [i.number, i]));
  const created = [], comments = [], patches = [], deliveries = [];
  let next = 900;
  const fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (!url.startsWith("https://api.github.com")) {          // the host webhook
      deliveries.push({ url, payload: body });
      if (webhook === "throw") throw new Error("ECONNREFUSED");
      return webhook === "ok" ? respond({}, 200) : respond("boom", 500);
    }
    const { pathname, searchParams } = new URL(url);
    const runJobs = pathname.match(/^\/repos\/o\/r\/actions\/runs\/(\d+)\/jobs$/);
    const one = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)$/);
    const onComments = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments$/);
    if (method === "GET" && pathname === `/repos/o/r/labels/${ALERT_LABEL}`) return respond({ name: ALERT_LABEL });
    if (method === "GET" && pathname === "/repos/o/r/actions/runs") return respond({ workflow_runs: runs });
    if (method === "GET" && runJobs) return respond({ jobs: jobs[runJobs[1]] || [] });
    if (method === "GET" && pathname === "/repos/o/r/issues") {
      const rows = [...store.values()].filter((i) => i.state === "open");
      return respond(Number(searchParams.get("page")) === 1 ? rows : []);
    }
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
  return { fetch, store, created, comments, patches, deliveries };
}

const run = (api, env = {}) => main({ auth, fetchImpl: api.fetch, env });
const openAlert = (over = {}) => ({
  number: 500, state: "open", title: "main is red: pr-gates is failing",
  body: `stale body\n\n${alertMarker("pr-gates")}`, ...over,
});

// --- Criterion 1: a failed run on main creates an alert on the next pass, and
// the default channel needs GitHub alone — no webhook, no external service.
{
  const api = makeApi({ runs: [redRun()] });
  const result = await run(api);
  assert.equal(result.opened, 1, "a red workflow on main must open exactly one alert");
  assert.equal(api.created.length, 1, "the default channel is a GitHub issue");
  assert.ok(api.created[0].labels.includes(ALERT_LABEL), `the alert must carry the ${ALERT_LABEL} label, got: ${api.created[0].labels}`);
  assert.ok(api.created[0].body.includes(alertMarker("pr-gates")), "the alert must carry its workflow marker");
  assert.equal(api.deliveries.length, 0, "the default channel must reach no external service");
}

// --- Criterion 1 (negative half): a green workflow on main raises nothing.
{
  const api = makeApi({ runs: [redRun({ conclusion: "success" })] });
  const result = await run(api);
  assert.equal(result.opened, 0, "a green workflow must not open an alert");
  assert.equal(api.created.length, 0, "a green workflow must create no issue");
}

// --- Criterion 2: a configured webhook receives the alert; a failed delivery
// falls back to the default channel (the alert issue) instead of being dropped.
{
  const api = makeApi({ runs: [redRun()] });
  await run(api, { RED_MAIN_ALERT_WEBHOOK: "https://hooks.example/red" });
  assert.equal(api.deliveries.length, 1, "a configured webhook must receive the alert");
  assert.equal(api.deliveries[0].url, "https://hooks.example/red", "the alert must go to the configured URL");
  assert.equal(api.deliveries[0].payload.event, "red", `the payload must name the transition, got: ${JSON.stringify(api.deliveries[0].payload)}`);
  assert.equal(api.comments.length, 0, "a successful delivery must record no fallback");
}
for (const outcome of ["500", "throw"]) {
  const api = makeApi({ runs: [redRun()], webhook: outcome });
  await run(api, { RED_MAIN_ALERT_WEBHOOK: "https://hooks.example/red" });
  assert.equal(api.created.length, 1, `a ${outcome} delivery must still leave the alert in the default channel`);
  const fallback = api.comments.find((c) => /delivery failed/i.test(c.body));
  assert.ok(fallback, `a ${outcome} delivery must record the fallback on the alert, got: ${JSON.stringify(api.comments)}`);
  assert.equal(fallback.issue, api.created[0].number, "the fallback note must land on the alert issue");
}

// --- Criterion 3: alerts fire on the red transition, not per red run: a second
// failure updates the one open alert, an unchanged run writes nothing.
{
  const api = makeApi({ runs: [redRun({ id: 2, run_number: 8, html_url: "https://github.com/o/r/actions/runs/2" })], issues: [openAlert()] });
  const result = await run(api, { RED_MAIN_ALERT_WEBHOOK: "https://hooks.example/red" });
  assert.equal(api.created.length, 0, "a workflow that stays red must not open a second alert");
  assert.equal(result.updated, 1, "the one open alert must be updated to the newest run");
  assert.ok(api.store.get(500).body.includes("runs/2"), "the updated alert must point at the newest run");
  assert.equal(api.deliveries.length, 0, "staying red must not re-deliver the alert to the webhook");

  const second = await run(api, { RED_MAIN_ALERT_WEBHOOK: "https://hooks.example/red" });
  assert.equal(second.updated, 0, "a pass over an unchanged red run must write nothing (idempotent)");
}

// --- Criterion 4: when the workflow recovers, the open alert resolves itself.
{
  const api = makeApi({
    runs: [redRun({ id: 3, conclusion: "success", run_number: 9, created_at: "2026-07-02T00:00:00Z" }), redRun()],
    issues: [openAlert()],
  });
  const result = await run(api);
  assert.equal(result.resolved, 1, "recovery must resolve the open alert");
  assert.equal(api.store.get(500).state, "closed", "the resolved alert must be closed");
  assert.ok(api.comments.some((c) => c.issue === 500 && /green again/i.test(c.body)), `the resolution must be explained on the alert, got: ${JSON.stringify(api.comments)}`);
}

// --- Criterion 5: the alert names the workflow, the run URL and the FIRST
// failing job — enough to start the fix without archaeology.
{
  const api = makeApi({
    runs: [redRun()],
    jobs: { 1: [{ name: "size", conclusion: "success" }, { name: "gates", conclusion: "failure" }, { name: "late", conclusion: "failure" }] },
  });
  await run(api);
  const body = api.created[0].body;
  assert.ok(body.includes("pr-gates"), `the alert must name the workflow, got:\n${body}`);
  assert.ok(body.includes("https://github.com/o/r/actions/runs/1"), `the alert must carry the run URL, got:\n${body}`);
  assert.match(body, /First failing job: gates/, `the alert must name the first failing job, got:\n${body}`);
}

// --- Criterion 5 (error path): a jobs listing that fails must degrade to a
// named unknown, never lose the alert.
{
  const api = makeApi({ runs: [redRun({ id: 4 })] });
  const flaky = (url, opts) => (/\/jobs\?/.test(url) ? Promise.reject(new Error("rate limited")) : api.fetch(url, opts));
  await main({ auth, fetchImpl: flaky, env: {} });
  assert.equal(api.created.length, 1, "an unreadable job list must not lose the alert");
  assert.match(api.created[0].body, /First failing job: unknown/, `an unreadable job list must degrade to a named unknown, got:\n${api.created[0].body}`);
}

console.log("PASS red-main-alert.test.mjs (5 criteria)");
