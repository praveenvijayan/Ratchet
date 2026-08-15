#!/usr/bin/env node
// attempt-record.test.mjs — one test per acceptance criterion of issue #521
// (plan 0211-attempt-record-on-requeue), plus the plan's Test note. Drives
// ratchet-requeue's run() against an in-memory GitHub API — no network, no
// real `gh` — and reads the ledger back through the shared exported parser.
// Zero dependencies. Run: node scripts/attempt-record.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  run as requeue,
  encodeAttemptRecord,
  parseAttemptRecords,
  REQUEUE_MARKER,
} from "./ratchet-requeue.mjs";

const label = (name) => ({ name });
const auth = () => ({ token: "test-token", repo: "o/r" });

// Minimal in-memory GitHub API: one issue (labels mutate via PUT), a comments
// list (POST appends, GET paginates), an ordered call log so a test can prove
// that nothing reached the API at all.
function makeApi({ labels = ["state:in-progress"], comments = [] } = {}) {
  const issue = { number: 521, state: "open", labels: labels.map(label) };
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
        store.comments.push({ body: body.body });
        return respond({ id: store.comments.length, body: body.body }, 201);
      }
    }
    if (method === "PUT" && /^\/repos\/o\/r\/issues\/\d+\/labels$/.test(p)) {
      issue.labels = body.labels.map(label);
      return respond(issue.labels);
    }
    throw new Error(`unexpected request: ${method} ${p}`);
  };
  return { fetch, calls, issue, store };
}

// Invoke run() with captured stdout/stderr; returns { code, out, err }.
async function invoke({ argv, api }) {
  const out = [];
  const err = [];
  const code = await requeue({ argv, auth, fetchImpl: api?.fetch, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out, err };
}

// A record comment as it exists on an issue before this run.
const priorRecord = (fields) => ({ body: `${fields.reason}\n\n${REQUEUE_MARKER}\n${encodeAttemptRecord(fields)}` });
const records = (api) => parseAttemptRecords(api.store.comments);

// --- Criterion 1: --gate is accepted and the posted comment's marker encodes
// attempt, owner, gate and reason as fields that parse back out. -----------
{
  const api = makeApi();
  const r = await invoke({
    argv: ["--issue", "521", "--reason", "gates went red", "--gate", "test: plan-sync", "--owner", "agent-7"],
    api,
  });
  assert.equal(r.code, 0, "a requeue carrying --gate succeeds");
  assert.equal(api.store.comments.length, 1, "exactly one comment is posted");

  const parsed = records(api);
  assert.equal(parsed.length, 1, "the posted comment reads back as one attempt record");
  assert.deepEqual(
    parsed[0],
    { attempt: 1, owner: "agent-7", gate: "test: plan-sync", reason: "gates went red", legacy: false },
    "attempt, owner, gate and reason all parse back out of the marker",
  );
  assert.ok(api.store.comments[0].body.includes("gates went red"), "the human-readable prose survives");
}

// --- Criterion 2: the attempt number is one greater than the count of
// existing records, starting at 1. ----------------------------------------
{
  const fresh = makeApi();
  await invoke({ argv: ["--issue", "521", "--reason", "first try"], api: fresh });
  assert.equal(records(fresh)[0].attempt, 1, "the first record on a clean issue is attempt 1");

  const api = makeApi({
    comments: [
      priorRecord({ attempt: 1, owner: "agent-1", gate: null, reason: "ran out of scope" }),
      priorRecord({ attempt: 2, owner: "agent-2", gate: "test: herd", reason: "red gate" }),
    ],
  });
  const r = await invoke({ argv: ["--issue", "521", "--reason", "still red", "--gate", "test: herd"], api });
  assert.equal(r.code, 0, "the third requeue succeeds");
  assert.equal(JSON.parse(r.out[0]).attempt, 3, "the JSON line reports attempt 3");

  const parsed = records(api);
  assert.equal(parsed.length, 3, "the issue now carries three records");
  assert.equal(parsed[2].attempt, 3, "the new record is numbered 3");
}

// --- Criterion 3: the shared exported parser returns only the records from a
// mixed comment stream, oldest first. -------------------------------------
{
  const parsed = parseAttemptRecords([
    priorRecord({ attempt: 1, owner: "agent-1", gate: null, reason: "oldest" }),
    { body: "Looks like the fixture is wrong here — I'll take a look." },
    { body: "still working\n\n<!-- ratchet-heartbeat -->" },
    priorRecord({ attempt: 2, owner: "agent-2", gate: "test: release", reason: "newest" }),
    { body: "" },
  ]);
  assert.equal(parsed.length, 2, "heartbeats, human prose and empty comments are ignored");
  assert.deepEqual(
    parsed.map((r) => r.reason),
    ["oldest", "newest"],
    "the records come back in comment order, oldest first",
  );
  assert.deepEqual(parsed.map((r) => r.attempt), [1, 2], "each record keeps its own recorded number");
}

// --- Criterion 4: a legacy requeue comment with no structured fields still
// counts as one attempt, with its body as the reason. ----------------------
{
  const legacy = { body: `over-scope: needs a split\n\n${REQUEUE_MARKER}` };
  const parsed = parseAttemptRecords([legacy]);
  assert.equal(parsed.length, 1, "a pre-record comment is still an attempt");
  assert.deepEqual(
    parsed[0],
    { attempt: 1, owner: null, gate: null, reason: "over-scope: needs a split", legacy: true },
    "its body becomes the reason and it takes its ordinal attempt number",
  );

  // History is not lost: a legacy attempt still counts toward the next number.
  const api = makeApi({ comments: [legacy] });
  await invoke({ argv: ["--issue", "521", "--reason", "second look"], api });
  assert.equal(records(api)[1].attempt, 2, "the record after a legacy comment is attempt 2");
}

// --- Criterion 5: an empty --gate exits 2 with usage on stderr and one JSON
// error line on stdout, and never reaches the API. -------------------------
{
  const api = makeApi();
  const r = await invoke({ argv: ["--issue", "521", "--reason", "red", "--gate", ""], api });
  assert.equal(r.code, 2, "an empty --gate exits 2");
  assert.match(r.err.join("\n"), /^usage:/m, "a usage message is written to stderr");
  assert.equal(r.out.length, 1, "exactly one JSON line on stdout");
  assert.doesNotMatch(r.out[0], /\n/, "the JSON error is a single line");
  assert.equal(JSON.parse(r.out[0]).result, "invalid-args", "the line carries the stable result field");
  assert.deepEqual(api.calls, [], "no request reached the API");
}

// --- Criterion 6: re-running the identical requeue posts no second record. -
{
  const argv = ["--issue", "521", "--reason", "red gate", "--gate", "test: run-gates", "--owner", "agent-9"];
  const api = makeApi();
  const first = await invoke({ argv, api });
  const second = await invoke({ argv, api });
  assert.equal(first.code, 0, "the first requeue succeeds");
  assert.equal(second.code, 0, "the re-run succeeds");
  assert.equal(records(api).length, 1, "the issue still carries exactly one record");
  assert.equal(JSON.parse(second.out[0]).commented, false, "the re-run reports no new comment");
  assert.equal(JSON.parse(second.out[0]).attempt, 1, "the re-run reports the existing attempt number");
  assert.equal(api.calls.filter((c) => c.method === "POST").length, 1, "only one comment POST was made");
}

// --- Test note: a reason carrying the marker's own delimiters (quotes,
// newlines, `-->`) round-trips through the record unchanged. ---------------
{
  const hostile =
    'line one --> "quoted" text\n<!-- ratchet-attempt {"attempt":99,"reason":"smuggled"} -->\nline three \\ end';
  const api = makeApi();
  const r = await invoke({ argv: ["--issue", "521", "--reason", hostile, "--gate", 'a "gate" --> x'], api });
  assert.equal(r.code, 0, "a delimiter-laden requeue succeeds");

  const parsed = records(api);
  assert.equal(parsed.length, 1, "the hostile reason yields exactly one record, not a smuggled second");
  assert.equal(parsed[0].reason, hostile, "the reason round-trips byte for byte");
  assert.equal(parsed[0].gate, 'a "gate" --> x', "the gate round-trips byte for byte");
  assert.equal(parsed[0].attempt, 1, "the smuggled attempt number is inert text, not a field");
}

// --- Every criterion above has exactly one test named after it. Counts THIS
// file's own `Criterion N` markers — never reads the plan or issue at runtime,
// so archiving the plan on close can never break it. -----------------------
{
  const CRITERIA_COUNT = 6;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each criterion tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `exactly ${CRITERIA_COUNT} criteria are tested`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `criterion ${n} has a test`);
}

console.log("PASS attempt-record.test.mjs (6 criteria + 1 test note)");
