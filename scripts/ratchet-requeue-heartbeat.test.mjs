#!/usr/bin/env node
// ratchet-requeue-heartbeat.test.mjs — one test per acceptance criterion of
// issue #336 (plan 0145-ratchet-requeue-heartbeat-scripts). Drives each
// script's run() against an in-memory GitHub API — no network, no real `gh`.
// Criterion 8 closes the loop by counting its own `Criterion N` markers.
// Zero dependencies. Run: node scripts/ratchet-requeue-heartbeat.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { run as requeue, REQUEUE_MARKER } from "./ratchet-requeue.mjs";
import { run as heartbeat } from "./ratchet-heartbeat.mjs";
import { HEARTBEAT_MARKER } from "./sweep-lease.mjs";

const label = (name) => ({ name });
const auth = () => ({ token: "test-token", repo: "o/r" });

// Minimal in-memory GitHub API: one issue (labels mutate via PUT), a comments
// list (POST appends, GET paginates), an ordered call log for ordering checks.
// `fail` names an endpoint that returns non-2xx to simulate an API failure.
function makeApi({ labels = [], comments = [], fail = null } = {}) {
  const issue = { number: 336, state: "open", labels: labels.map(label) };
  const store = { comments: [...comments] };
  const calls = [];
  const respond = (data, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    const p = u.pathname;
    calls.push({ method, path: p });
    if (method === "GET" && /^\/repos\/o\/r\/issues\/\d+$/.test(p)) return respond(issue);
    if (/^\/repos\/o\/r\/issues\/\d+\/comments$/.test(p)) {
      if (method === "GET") return respond(Number(u.searchParams.get("page") || "1") === 1 ? store.comments : []);
      if (method === "POST") {
        if (fail === "comment") return respond("Forbidden", 403);
        store.comments.push({ body: body.body });
        return respond({ id: store.comments.length, body: body.body }, 201);
      }
    }
    if (method === "PUT" && /^\/repos\/o\/r\/issues\/\d+\/labels$/.test(p)) {
      if (fail === "labels") return respond("Forbidden", 403);
      issue.labels = body.labels.map(label);
      return respond(issue.labels);
    }
    throw new Error(`unexpected request: ${method} ${p}`);
  };
  return { fetch, calls, issue, store };
}

// Invoke a script's run() with captured stdout/stderr; returns { code, out, err }.
async function invoke(run, { argv, api }) {
  const out = [];
  const err = [];
  const code = await run({ argv, auth, fetchImpl: api?.fetch, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out, err };
}

const stateLabels = (api) => api.issue.labels.map((l) => l.name).filter((n) => n.startsWith("state:"));
const reasonComments = (api) =>
  api.store.comments.filter((c) => c.body.includes(REQUEUE_MARKER) && c.body.includes("scope too big"));
const REQ = ["--issue", "336", "--reason", "scope too big"];

// --- Criterion 1: requeue posts a comment with the reason, adds state:ready,
// and removes whichever in-flight state label was present. ----------------
for (const inflight of ["state:in-progress", "state:in-review", "state:changes-requested"]) {
  const api = makeApi({ labels: [inflight, "priority:high"] });
  const r = await invoke(requeue, { argv: REQ, api });
  assert.equal(r.code, 0, `requeue from ${inflight} succeeds`);
  assert.deepEqual(stateLabels(api), ["state:ready"], `${inflight} -> state:ready (in-flight removed)`);
  assert.ok(api.issue.labels.some((l) => l.name === "priority:high"), "non-state labels preserved");
  assert.equal(reasonComments(api).length, 1, "the reason comment is posted");
  assert.ok(reasonComments(api)[0].body.includes("scope too big"), "the comment carries the reason");
}

// --- Criterion 2: requeue is idempotent — re-running leaves exactly one state
// label (state:ready) and does not duplicate the reason comment. ----------
{
  const api = makeApi({ labels: ["state:in-progress"] });
  const first = await invoke(requeue, { argv: REQ, api });
  const second = await invoke(requeue, { argv: REQ, api });
  assert.equal(first.code, 0, "first requeue succeeds");
  assert.equal(second.code, 0, "second requeue succeeds");
  assert.deepEqual(stateLabels(api), ["state:ready"], "exactly one state label after re-run");
  assert.equal(reasonComments(api).length, 1, "the reason comment is not duplicated");
  assert.equal(JSON.parse(second.out[0]).commented, false, "the re-run reports no new comment");
}

// --- Criterion 3: the comment is posted before the label flip, so an
// interrupted run never leaves an unexplained state change. ---------------
{
  const api = makeApi({ labels: ["state:in-progress"] });
  await invoke(requeue, { argv: REQ, api });
  const postIdx = api.calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/comments"));
  const putIdx = api.calls.findIndex((c) => c.method === "PUT" && c.path.endsWith("/labels"));
  assert.ok(postIdx !== -1 && putIdx !== -1 && postIdx < putIdx, "comment POST precedes label PUT");

  // If the label write fails, the comment already explains intent and the state
  // label is left untouched — never an unexplained flip.
  const fapi = makeApi({ labels: ["state:in-progress"], fail: "labels" });
  const r = await invoke(requeue, { argv: REQ, api: fapi });
  assert.equal(r.code, 1, "a failed label write exits non-zero");
  assert.equal(reasonComments(fapi).length, 1, "the explaining comment was still posted");
  assert.deepEqual(stateLabels(fapi), ["state:in-progress"], "the state label is unchanged");
}

// --- Criterion 4: heartbeat posts an issue comment containing the
// <!-- ratchet-heartbeat --> marker that sweep-stale-claims recognises. ----
{
  const api = makeApi({});
  const r = await invoke(heartbeat, { argv: ["--issue", "336"], api });
  assert.equal(r.code, 0, "heartbeat succeeds");
  assert.equal(api.store.comments.length, 1, "exactly one comment is posted");
  assert.ok(api.store.comments[0].body.includes(HEARTBEAT_MARKER), "the comment carries the heartbeat marker");
  assert.equal(JSON.parse(r.out[0]).result, "heartbeat", "the result field names the outcome");
}

// --- Criterion 5: missing or invalid arguments exit 2 with a usage message;
// an API failure exits non-zero with a single-line JSON error and no partial
// label state. ------------------------------------------------------------
{
  for (const [run, argv] of [
    [requeue, ["--issue", "abc", "--reason", "x"]],
    [requeue, ["--issue", "1"]],
    [heartbeat, []],
    [heartbeat, ["--issue", "0"]],
  ]) {
    const r = await invoke(run, { argv, api: makeApi({}) });
    assert.equal(r.code, 2, `invalid args exit 2 (${argv.join(" ") || "none"})`);
    assert.match(r.err.join("\n"), /usage:/, "a usage message is written to stderr");
  }
  const fapi = makeApi({ labels: ["state:in-progress"], fail: "comment" });
  const r = await invoke(requeue, { argv: REQ, api: fapi });
  assert.equal(r.code, 1, "an API failure exits non-zero");
  assert.equal(r.out.length, 1, "exactly one JSON line on failure");
  assert.doesNotMatch(r.out[0], /\n/, "the JSON error is a single line");
  assert.equal(JSON.parse(r.out[0]).result, "error", "the error carries a stable result field");
  assert.ok(!fapi.calls.some((c) => c.method === "PUT"), "no label write occurred (no partial state)");
}

// --- Criterion 6: every outcome prints exactly one line of JSON to stdout
// with a stable `result` field. -------------------------------------------
{
  const outcomes = [
    await invoke(requeue, { argv: ["--issue", "336", "--reason", "r"], api: makeApi({ labels: ["state:in-review"] }) }),
    await invoke(requeue, { argv: ["--bad"], api: makeApi({}) }),
    await invoke(requeue, { argv: ["--issue", "336", "--reason", "r"], api: makeApi({ fail: "comment" }) }),
    await invoke(heartbeat, { argv: ["--issue", "336"], api: makeApi({}) }),
    await invoke(heartbeat, { argv: [], api: makeApi({}) }),
  ];
  for (const o of outcomes) {
    assert.equal(o.out.length, 1, "exactly one stdout line per outcome");
    const parsed = JSON.parse(o.out[0]);
    assert.ok(typeof parsed.result === "string" && parsed.result.length > 0, "the line has a stable result field");
  }
}

// --- Criterion 7: GitHub access goes through scripts/gh-api.mjs
// (resolveAuth/ghClient); neither script defines a private fetch client or
// token resolution. -------------------------------------------------------
{
  for (const name of ["ratchet-requeue.mjs", "ratchet-heartbeat.mjs"]) {
    const src = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
    assert.match(src, /from\s+["']\.\/gh-api\.mjs["']/, `${name} imports the shared gh-api client`);
    assert.match(src, /ghClient\(/, `${name} builds its client via ghClient`);
    assert.doesNotMatch(src, /\bfetch\s*\(/, `${name} defines no private fetch client`);
    assert.doesNotMatch(src, /GITHUB_TOKEN|auth["']?,\s*\[["']token/, `${name} does no token resolution`);
  }
}

// --- Criterion 8: every criterion above has exactly one test named after it.
// Counts THIS file's own `Criterion N` markers — never reads the plan or issue
// at runtime, so archiving the plan on close can never break it. -----------
{
  const CRITERIA_COUNT = 8;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each criterion tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `exactly ${CRITERIA_COUNT} criteria are tested`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `criterion ${n} has a test`);
}

console.log("PASS ratchet-requeue-heartbeat.test.mjs (8 criteria)");
