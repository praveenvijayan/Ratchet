#!/usr/bin/env node
// conflicted-prs.test.mjs — one test per acceptance criterion of issue #269
// (plan 0118-conflicted-pr-visibility): a scheduled pass marks open PRs with
// merge conflicts (`mergeable_state: dirty`) with a `conflict` label so
// reviewers skip them until the agent rebases. Drives main() against an
// in-memory GitHub API, plus unit tests for the pure decideAction() core.
// Criterion 4 (idempotency) closes the loop by counting its own sibling tests
// against the plan's criteria. Zero dependencies. Run:
// node scripts/conflicted-prs.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { decideAction, main, CONFLICT_LABEL } from "./conflicted-prs.mjs";

const label = (name) => ({ name });

// Minimal in-memory GitHub API. Open PRs live in the `prs` Map (keyed by
// number); label writes land on `posts`/`deletes` for inspection. The list
// endpoint returns PRs WITHOUT mergeability fields (matching GitHub); the
// detail endpoint (GET /pulls/<N>) returns the full PR with mergeable and
// mergeable_state. fetch is reset per test.
function makeApi(prStore) {
  const prs = new Map(prStore);
  const posts = [];   // POST label-adds: { pr, labels }
  const deletes = []; // DELETE label-removes: { pr, label }
  const respond = (data, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });
  const fetch = async (url, opts = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    const pullsList = pathname === "/repos/o/r/pulls";
    const pullsDetail = pathname.match(/^\/repos\/o\/r\/pulls\/(\d+)$/);
    const labelsIssue = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/labels$/);
    const labelsIssueDel = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/labels\/(.+)$/);
    const labelsRepo = pathname === "/repos/o/r/labels" || pathname.match(/^\/repos\/o\/r\/labels\/(.+)$/);
    // GET /repos/.../labels/<name> — label existence check (ensureLabel)
    if (method === "GET" && pathname === "/repos/o/r/labels/conflict") return respond({ message: "Not Found" }, 404);
    // POST /repos/.../labels — label create (ensureLabel)
    if (method === "POST" && pathname === "/repos/o/r/labels") return respond({ name: CONFLICT_LABEL });
    // GET /repos/.../pulls?state=open — list (no mergeability fields)
    if (method === "GET" && pullsList) {
      const state = searchParams.get("state") || "open";
      const list = [...prs.values()].filter((p) => p.state === state).map((p) => ({
        number: p.number,
        state: p.state,
        labels: p.labels,
      }));
      return respond(list);
    }
    // GET /repos/.../pulls/<N> — detail (with mergeable, mergeable_state)
    if (method === "GET" && pullsDetail) {
      const pr = prs.get(Number(pullsDetail[1]));
      return pr ? respond(pr) : respond({ message: "Not Found" }, 404);
    }
    // POST /repos/.../issues/<N>/labels — add label to PR
    if (method === "POST" && labelsIssue) {
      const n = Number(labelsIssue[1]);
      const pr = prs.get(n);
      if (body?._fail) return respond({ message: "Forbidden" }, 403);
      posts.push({ pr: n, labels: body.labels });
      if (pr) pr.labels = [...pr.labels, ...body.labels.map(label)];
      return respond(body.labels.map(label));
    }
    // DELETE /repos/.../issues/<N>/labels/<name> — remove label from PR
    if (method === "DELETE" && labelsIssueDel) {
      const n = Number(labelsIssueDel[1]);
      const name = labelsIssueDel[2];
      const pr = prs.get(n);
      deletes.push({ pr: n, label: name });
      if (pr) pr.labels = pr.labels.filter((l) => (typeof l === "string" ? l !== name : l.name !== name));
      return respond(null, 204);
    }
    throw new Error(`unexpected request: ${method} ${pathname}`);
  };
  return { fetch, posts, deletes };
}

const baseEnv = () => {
  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "o/r";
};

const capture = async (fetch) => {
  const prev = globalThis.fetch;
  globalThis.fetch = fetch;
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let result, error;
  try {
    result = await main();
  } catch (e) {
    error = e;
  } finally {
    console.log = realLog;
    globalThis.fetch = prev;
  }
  return { result, error, logs };
};

// --- Criterion 1: An open PR with merge conflicts (`mergeable_state: dirty`)
// receives a conflict label. -------------------------------------------------
{
  baseEnv();
  // Unit: the pure decision marks a dirty PR as "add".
  assert.equal(decideAction(false, "dirty"), "add", "a dirty PR decides 'add'");

  // Integration: main() labels a conflicted PR that has no label yet.
  const api = makeApi([
    [7, { number: 7, state: "open", labels: [], mergeable: false, mergeable_state: "dirty" }],
  ]);
  const r = await capture(api.fetch);
  assert.equal(r.error, undefined, `must not error: ${r.error?.message ?? ""}`);
  assert.equal(r.result.labeled, 1, "one PR labeled");
  assert.deepEqual(api.posts, [{ pr: 7, labels: [CONFLICT_LABEL] }], "the conflicted PR receives the conflict label");
  assert.equal(api.deletes.length, 0, "no label removed");
}

// --- Criterion 2: The conflict label is removed once the PR becomes
// mergeable again. ----------------------------------------------------------
{
  baseEnv();
  // Unit: a clean, mergeable PR decides "remove".
  assert.equal(decideAction(true, "clean"), "remove", "a clean PR decides 'remove'");

  // Integration: main() removes the label from a previously-labeled PR that is
  // now mergeable.
  const api = makeApi([
    [7, { number: 7, state: "open", labels: [label(CONFLICT_LABEL)], mergeable: true, mergeable_state: "clean" }],
  ]);
  const r = await capture(api.fetch);
  assert.equal(r.error, undefined, `must not error: ${r.error?.message ?? ""}`);
  assert.equal(r.result.unlabeled, 1, "one PR unlabeled");
  assert.deepEqual(api.deletes, [{ pr: 7, label: CONFLICT_LABEL }], "the conflict label is removed from the now-mergeable PR");
  assert.equal(api.posts.length, 0, "no label added");
}

// --- Criterion 3: A PR whose mergeability GitHub has not yet computed
// (`mergeable: null`) is skipped, not labeled. ------------------------------
{
  baseEnv();
  // Unit: a null mergeable decides "skip" regardless of mergeable_state.
  assert.equal(decideAction(null, "unknown"), "skip", "a null-mergeable PR decides 'skip'");
  assert.equal(decideAction(null, "dirty"), "skip", "even with state 'dirty', null mergeable still skips");

  // Integration: main() leaves a null-mergeable PR alone — no add, no remove.
  const api = makeApi([
    [7, { number: 7, state: "open", labels: [], mergeable: null, mergeable_state: "unknown" }],
  ]);
  const r = await capture(api.fetch);
  assert.equal(r.error, undefined, `must not error: ${r.error?.message ?? ""}`);
  assert.equal(r.result.skipped, 1, "the null-mergeable PR is skipped");
  assert.equal(api.posts.length, 0, "no label added to a null-mergeable PR");
  assert.equal(api.deletes.length, 0, "no label removed from a null-mergeable PR");
}

// --- Criterion 4: Re-running the pass on an already-labeled conflicted PR
// changes nothing (idempotent). ----------------------------------------------
{
  baseEnv();
  // A conflicted PR that already has the label: no API write fires. Also
  // covers the symmetric case: a mergeable PR with no label does nothing.
  const api = makeApi([
    [7, { number: 7, state: "open", labels: [label(CONFLICT_LABEL)], mergeable: false, mergeable_state: "dirty" }],
    [8, { number: 8, state: "open", labels: [], mergeable: true, mergeable_state: "clean" }],
  ]);
  const r = await capture(api.fetch);
  assert.equal(r.error, undefined, `must not error: ${r.error?.message ?? ""}`);
  assert.equal(api.posts.length, 0, "no label re-added to an already-labeled conflicted PR");
  assert.equal(api.deletes.length, 0, "no label removed from a clean PR with no label");
  assert.match(r.logs.join("\n"), /already labeled/, "the idempotent no-op is logged");

  // Self-count: every criterion above has exactly one test named after it.
  const CRITERIA_COUNT = 4;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each criterion tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `criterion ${n} has a test`);
}

console.log("PASS conflicted-prs.test.mjs (4 criteria)");
