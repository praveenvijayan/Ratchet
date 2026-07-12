#!/usr/bin/env node
// ratchet-submit.test.mjs — one test per acceptance criterion of issue #337
// (plan 0146-ratchet-submit-script). Drives run() with a stubbed git runner,
// gate runner, and in-memory GitHub API — no network, no real git or `gh`.
// Criterion 8 closes the loop by counting its own `Criterion N` markers.
// Zero dependencies. Run: node scripts/ratchet-submit.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { run as submit } from "./ratchet-submit.mjs";

const label = (name) => ({ name });
const auth = () => ({ token: "test-token", repo: "o/r" });
const BODY = `Closes #337\n\nA model-authored summary.`;

// Stub git: dispatch by argv. `integrated` toggles the is-ancestor result;
// `conflict` makes merge-tree report a conflict; `pushCode` fails the push.
function makeGit({ integrated = true, conflict = false, pushCode = 0 } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const j = args.join(" ");
    if (j.startsWith("merge-base --is-ancestor")) return { code: integrated ? 0 : 1, stdout: "" };
    if (j.startsWith("merge-tree")) return { code: 0, stdout: conflict ? "CONFLICT (content): x\n" : "" };
    if (j.startsWith("push")) return { code: pushCode, stdout: "" };
    return { code: 0, stdout: "" };
  };
  run.calls = calls;
  return run;
}
const pushed = (git) => git.calls.some((a) => a[0] === "push");

// In-memory GitHub API: list/create pulls, read issue, write labels.
function makeApi({ pulls = [], title = "Add submit script", labels = ["state:in-progress"] } = {}) {
  const store = { pulls: [...pulls], posts: 0 };
  const issue = { number: 337, title, labels: labels.map(label) };
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
    if (method === "GET" && p === "/repos/o/r/pulls") return respond(store.pulls);
    if (method === "POST" && p === "/repos/o/r/pulls") {
      store.posts++;
      store.pulls.push({ number: 100 + store.pulls.length, head: { ref: body.head } });
      return respond(store.pulls[store.pulls.length - 1], 201);
    }
    if (method === "GET" && p === "/repos/o/r/issues/337") return respond(issue);
    if (method === "PUT" && p === "/repos/o/r/issues/337/labels") {
      issue.labels = body.labels.map(label);
      return respond(issue.labels);
    }
    throw new Error(`unexpected request: ${method} ${p}`);
  };
  return { fetch, store, issue };
}

// Invoke run() with captured stdout/stderr and injected stubs.
async function invoke({ argv = ["--issue", "337", "--body-file", "body.md"], api, git = makeGit(), gates = () => 0, body = BODY } = {}) {
  const out = [];
  const err = [];
  const code = await submit({
    argv,
    auth,
    fetchImpl: api?.fetch,
    runGit: git,
    runGates: gates,
    readBody: () => body,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out, err, git, api };
}
const stateLabels = (api) => api.issue.labels.map((l) => l.name).filter((n) => n.startsWith("state:"));

// --- Criterion 1: exits 4 without pushing when the branch does not contain
// current origin/main or the merge would conflict. ------------------------
{
  const notInteg = await invoke({ api: makeApi({}), git: makeGit({ integrated: false, conflict: false }) });
  assert.equal(notInteg.code, 4, "un-integrated branch exits 4");
  assert.equal(JSON.parse(notInteg.out[0]).result, "not-integrated", "result names not-integrated");
  assert.ok(!pushed(notInteg.git), "un-integrated branch is not pushed");

  const confl = await invoke({ api: makeApi({}), git: makeGit({ integrated: false, conflict: true }) });
  assert.equal(confl.code, 4, "a conflicting merge exits 4");
  assert.equal(JSON.parse(confl.out[0]).result, "conflict", "result names conflict");
  assert.ok(!pushed(confl.git), "a conflicting branch is not pushed");
}

// --- Criterion 2: the gates run fail-fast via run-gates; any red gate exits 5
// and nothing is pushed. --------------------------------------------------
{
  let ran = 0;
  const r = await invoke({ api: makeApi({}), gates: () => { ran++; return 5; } });
  assert.equal(r.code, 5, "a red gate exits 5");
  assert.equal(ran, 1, "the gate runner was invoked");
  assert.equal(JSON.parse(r.out[0]).result, "red-gate", "result names red-gate");
  assert.ok(!pushed(r.git), "red gates mean nothing is pushed");
}

// --- Criterion 3: a body file whose first line is not exactly `Closes #<N>`
// exits 2 without pushing. ------------------------------------------------
{
  const r = await invoke({ api: makeApi({}), body: "Fixes #337\n\nsummary" });
  assert.equal(r.code, 2, "a bad body first line exits 2");
  assert.equal(JSON.parse(r.out[0]).result, "bad-body", "result names bad-body");
  assert.ok(!pushed(r.git), "a bad body is not pushed");
}

// --- Criterion 4: on success the branch is pushed, the PR is created when none
// exists (or the existing one kept — never a second), state:in-review is set
// and state:in-progress removed. ------------------------------------------
{
  const create = await invoke({ api: makeApi({ pulls: [] }) });
  assert.equal(create.code, 0, "success exits 0");
  assert.ok(pushed(create.git), "the branch is pushed");
  assert.equal(create.api.store.posts, 1, "a PR is created when none exists");
  assert.deepEqual(stateLabels(create.api), ["state:in-review"], "state:in-review set, in-progress removed");

  const existing = [{ number: 42, head: { ref: "agent/issue-337" } }];
  const keep = await invoke({ api: makeApi({ pulls: existing }) });
  assert.equal(keep.code, 0, "success with an existing PR exits 0");
  assert.equal(keep.api.store.posts, 0, "no second PR is created");
  assert.equal(keep.api.store.pulls.length, 1, "still exactly one PR");
}

// --- Criterion 5: re-running after success is idempotent — exit 0 and still
// exactly one PR for the branch. ------------------------------------------
{
  const api = makeApi({ pulls: [] });
  const first = await invoke({ api });
  const second = await invoke({ api });
  assert.equal(first.code, 0, "first submit succeeds");
  assert.equal(second.code, 0, "re-run exits 0");
  assert.equal(api.store.pulls.length, 1, "still exactly one PR after re-run");
  assert.equal(JSON.parse(second.out[0]).result, "already-submitted", "the re-run reports idempotence");
}

// --- Criterion 6: missing or invalid arguments exit 2 with a usage message;
// every outcome prints exactly one line of JSON with a stable result field. -
{
  for (const argv of [[], ["--issue", "abc", "--body-file", "b"], ["--issue", "1"]]) {
    const r = await invoke({ argv, api: makeApi({}) });
    assert.equal(r.code, 2, `invalid args exit 2 (${argv.join(" ") || "none"})`);
    assert.match(r.err.join("\n"), /usage:/, "a usage message is written to stderr");
  }
  const outcomes = [
    await invoke({ argv: [], api: makeApi({}) }),
    await invoke({ api: makeApi({}), git: makeGit({ integrated: false }) }),
    await invoke({ api: makeApi({}), gates: () => 5 }),
    await invoke({ api: makeApi({ pulls: [] }) }),
  ];
  for (const o of outcomes) {
    assert.equal(o.out.length, 1, "exactly one stdout line per outcome");
    assert.ok(typeof JSON.parse(o.out[0]).result === "string", "the line has a stable result field");
  }
}

// --- Criterion 7: GitHub access goes through scripts/gh-api.mjs
// (resolveAuth/ghClient); the script defines no private fetch client or token
// resolution. -------------------------------------------------------------
{
  const src = readFileSync(fileURLToPath(new URL("./ratchet-submit.mjs", import.meta.url)), "utf8");
  assert.match(src, /from\s+["']\.\/gh-api\.mjs["']/, "imports the shared gh-api client");
  assert.match(src, /ghClient\(/, "builds its client via ghClient");
  assert.doesNotMatch(src, /\bfetch\s*\(/, "defines no private fetch client");
  assert.doesNotMatch(src, /GITHUB_TOKEN|auth["']?,\s*\[["']token/, "does no token resolution");
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

console.log("PASS ratchet-submit.test.mjs (8 criteria)");
