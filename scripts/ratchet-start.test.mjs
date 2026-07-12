#!/usr/bin/env node
// ratchet-start.test.mjs — one test per acceptance criterion of issue #335
// (plan 0144). Drives run() with a stubbed git runner, an in-memory filesystem,
// and an in-memory GitHub API — no network, no real git or `gh`, never a real
// worktree. Criterion 9 closes the loop by counting its own `Criterion N`
// markers. Zero dependencies. Run: node scripts/ratchet-start.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run as start } from "./ratchet-start.mjs";

const auth = () => ({ token: "t", repo: "o/r" });
const OWNER = "claude-code slate-otter-3581";
const WT = "../wt/issue-335";
const EXCLUDE = join("/fake/.git", "info", "exclude");
const MARKER = join(WT, ".ratchet-owner");

// A world whose git runner, filesystem, and GitHub API share one event log, so a
// test can assert both what happened and the order it happened in.
function makeWorld({ labels = ["state:ready", "priority:medium"], refConflict = false, failAt = null, seedWorktree = null } = {}) {
  const events = [], files = new Map(), dirs = new Set();
  if (seedWorktree) { dirs.add(WT); files.set(MARKER, seedWorktree); }
  const fs = {
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => { if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files.get(p); },
    writeFileSync: (p, c) => { files.set(p, c); events.push(`fs:write ${p}`); },
    appendFileSync: (p, c) => { files.set(p, (files.get(p) || "") + c); events.push(`fs:append ${p}`); },
  };
  const git = (args) => {
    git.calls.push(args);
    const j = args.join(" ");
    events.push(`git:${j}`);
    if (j === "rev-parse --git-common-dir") return { code: 0, stdout: "/fake/.git\n" };
    if (args[0] === "worktree" && args[1] === "add") { dirs.add(args[2]); return { code: 0, stdout: "" }; }
    return { code: 0, stdout: "" };
  };
  git.calls = [];
  const issue = { number: 335, labels: labels.map((name) => ({ name })) };
  const store = { refs: new Set(), labelPuts: [], assignees: [] };
  const respond = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => (typeof data === "string" ? data : JSON.stringify(data)) });
  const fetch = async (url, opts = {}) => {
    const p = new URL(url).pathname, method = opts.method || "GET", body = opts.body ? JSON.parse(opts.body) : undefined;
    events.push(`api:${method} ${p}`);
    if (failAt && p === failAt) return respond("boom\nstack line\n at foo", 500);
    if (p === "/repos/o/r/git/ref/heads/main") return respond({ object: { sha: "MAINSHA" } });
    if (method === "POST" && p === "/repos/o/r/git/refs") {
      if (refConflict) return respond("Reference already exists", 422);
      store.refs.add(body.ref);
      return respond({ ref: body.ref }, 201);
    }
    if (method === "GET" && p === "/repos/o/r/issues/335") return respond(issue);
    if (method === "PUT" && p === "/repos/o/r/issues/335/labels") { store.labelPuts.push(body.labels); issue.labels = body.labels.map((name) => ({ name })); return respond(issue.labels); }
    if (p === "/user") return respond({ login: "tester" });
    if (method === "POST" && p === "/repos/o/r/issues/335/assignees") { store.assignees.push(...body.assignees); return respond(issue, 201); }
    throw new Error(`unexpected request: ${method} ${p}`);
  };
  return { events, files, dirs, fs, git, fetch, store, issue };
}

async function invoke({ argv = ["--issue", "335", "--owner", OWNER], world } = {}) {
  const out = [], err = [];
  const code = await start({ argv, auth, fetchImpl: world.fetch, runGit: world.git, fs: world.fs, out: (s) => out.push(s), err: (s) => err.push(s), now: () => "TS" });
  return { code, out, err, world, json: out.length ? JSON.parse(out[0]) : null };
}
const stateLabels = (w) => w.issue.labels.map((l) => l.name).filter((n) => n.startsWith("state:"));
const addedWorktree = (w) => w.git.calls.some((a) => a[0] === "worktree" && a[1] === "add");

// --- Criterion 1: creates the ref server-side from current origin/main BEFORE
// any local mutation, adds the worktree, writes .ratchet-owner with the owner
// id, and registers .ratchet-owner in the shared info/exclude. -------------
{
  const w = makeWorld();
  assert.equal((await invoke({ world: w })).code, 0, "a fresh claim succeeds");
  assert.ok(w.store.refs.has("refs/heads/agent/issue-335"), "the branch ref is created server-side");
  const refIdx = w.events.indexOf("api:POST /repos/o/r/git/refs");
  assert.ok(refIdx !== -1 && refIdx < w.events.findIndex((e) => e.startsWith("git:")), "the ref is created before any local git mutation");
  assert.ok(w.git.calls.some((a) => a[0] === "worktree" && a[1] === "add" && a[2] === WT && a[3] === "agent/issue-335"), "the worktree is added at ../wt/issue-335");
  assert.equal(w.files.get(MARKER), `${OWNER} issue-335 claimed TS\n`, "the owner marker is written with the owner id");
  assert.ok((w.files.get(EXCLUDE) || "").split("\n").some((l) => l.trim() === ".ratchet-owner"), ".ratchet-owner is registered in the shared info/exclude");
}

// --- Criterion 2: a pre-existing claim ref (HTTP 422) exits 3 identifying the
// claim as foreign, with no local or remote mutation performed. ------------
{
  const w = makeWorld({ refConflict: true });
  const r = await invoke({ world: w });
  assert.equal(r.code, 3, "a 422 exits 3");
  assert.equal(r.json.result, "foreign", "the result identifies the claim as foreign");
  assert.equal(w.store.refs.size, 0, "no ref is created (remote unchanged)");
  assert.equal(w.git.calls.length + w.files.size, 0, "no local mutation is performed");
  assert.deepEqual(w.store.labelPuts, [], "no label flip is performed");
}

// --- Criterion 3: after a successful claim the issue has state:in-progress, no
// longer has state:ready, and is assigned to the authenticated user. -------
{
  const w = makeWorld();
  await invoke({ world: w });
  assert.deepEqual(stateLabels(w), ["state:in-progress"], "state:in-progress set, state:ready removed");
  assert.deepEqual(w.store.assignees, ["tester"], "assigned to the authenticated user");
}

// --- Criterion 4: re-running with an existing worktree resumes (exit 0, reused,
// no duplicate) when .ratchet-owner matches, and exits 4 with no mutation when
// it does not. -------------------------------------------------------------
{
  const m = makeWorld({ seedWorktree: `${OWNER} issue-335 claimed earlier\n` });
  const rm = await invoke({ world: m });
  assert.equal(rm.code, 0, "a matching owner resumes with exit 0");
  assert.equal(rm.json.result, "resumed", "the result reports a resume");
  assert.equal(m.store.refs.size + m.git.calls.length, 0, "no duplicate ref or worktree on resume");

  const x = makeWorld({ seedWorktree: "someone-else issue-335 claimed earlier\n" });
  const rx = await invoke({ world: x });
  assert.equal(rx.code, 4, "a mismatched owner exits 4");
  assert.equal(rx.json.result, "unsafe", "the result reports unsafe");
  assert.ok(x.store.refs.size === 0 && x.git.calls.length === 0 && !x.events.some((e) => e.startsWith("fs:")), "a mismatched re-run performs no mutation");
}

// --- Criterion 5: the shared clone's checked-out branch is never changed; all
// attachment happens via the worktree. -------------------------------------
{
  const w = makeWorld();
  await invoke({ world: w });
  assert.ok(addedWorktree(w), "attachment uses git worktree add");
  assert.ok(!w.git.calls.some((a) => a[0] === "checkout" || a[0] === "switch"), "no checkout/switch ever runs in the shared clone");
}

// --- Criterion 6: missing or invalid arguments exit 2 with a usage message and
// no mutation. -------------------------------------------------------------
{
  for (const argv of [[], ["--issue", "abc", "--owner", OWNER], ["--issue", "5"], ["--issue", "5", "--owner", "  "]]) {
    const w = makeWorld();
    const r = await invoke({ argv, world: w });
    assert.equal(r.code, 2, `invalid args exit 2 (${argv.join(" ") || "none"})`);
    assert.match(r.err.join("\n"), /usage:/, "a usage message is written to stderr");
    assert.equal(w.store.refs.size + w.git.calls.length + w.files.size, 0, "no mutation on a usage error");
  }
}

// --- Criterion 7: every outcome prints exactly one line of JSON with a stable
// result field and never a raw stack trace. --------------------------------
{
  const outcomes = [
    await invoke({ argv: [], world: makeWorld() }),
    await invoke({ world: makeWorld({ refConflict: true }) }),
    await invoke({ world: makeWorld({ seedWorktree: "other issue-335 x\n" }) }),
    await invoke({ world: makeWorld({ failAt: "/repos/o/r/issues/335/labels" }) }),
    await invoke({ world: makeWorld() }),
  ];
  for (const o of outcomes) {
    assert.equal(o.out.length, 1, "exactly one stdout line per outcome");
    assert.equal(typeof o.json.result, "string", "the line has a stable string result field");
    assert.ok(!/\bat \S+:\d+/.test(o.out[0]) && !o.out[0].includes("\n"), "the line carries no raw multi-line stack trace");
  }
}

// --- Criterion 8: GitHub access goes through scripts/gh-api.mjs
// (resolveAuth/ghClient); the script defines no private fetch client or token
// resolution. --------------------------------------------------------------
{
  const src = readFileSync(fileURLToPath(new URL("./ratchet-start.mjs", import.meta.url)), "utf8");
  assert.match(src, /from\s+["']\.\/gh-api\.mjs["']/, "imports the shared gh-api client");
  assert.match(src, /ghClient\(/, "builds its client via ghClient");
  assert.doesNotMatch(src, /\bfetch\s*\(/, "defines no private fetch client");
  assert.doesNotMatch(src, /GITHUB_TOKEN|GITHUB_PAT|auth\s+token/, "does no token resolution");
}

// --- Test note: a mid-run API failure (label flip fails after the ref and
// worktree exist) reports one JSON error line, exits 1, and leaves no partial
// state violating the invariants — no worktree without an owner marker, no label
// flip without a claim ref. ------------------------------------------------
{
  const w = makeWorld({ failAt: "/repos/o/r/issues/335/labels" });
  const r = await invoke({ world: w });
  assert.equal(r.code, 1, "a mid-run API failure exits 1");
  assert.equal(r.json.result, "error", "the result reports an error");
  assert.ok(w.store.refs.has("refs/heads/agent/issue-335"), "the label flip was only attempted after the claim ref existed");
  assert.equal(addedWorktree(w), w.files.has(MARKER), "a worktree never exists without its owner marker");
  assert.deepEqual(w.store.labelPuts, [], "the failed label flip left no labels applied");
}

// --- Property: running twice with identical arguments equals running once. The
// first run claims; the second sees the worktree its predecessor left and
// resumes without a duplicate ref or worktree. -----------------------------
{
  const w = makeWorld();
  const first = await invoke({ world: w });
  const second = await invoke({ world: w });
  assert.equal(first.code, 0, "the first run claims");
  assert.equal(second.json.result, "resumed", "the second run resumes rather than re-claims");
  assert.equal(w.store.refs.size, 1, "exactly one ref exists after two runs");
  assert.equal(w.git.calls.filter((a) => a[0] === "worktree" && a[1] === "add").length, 1, "the worktree is added exactly once");
}

// --- Criterion 9: every criterion above has exactly one test named after it.
// Counts THIS file's own `Criterion N` markers so archiving the plan on close
// can never break it. ------------------------------------------------------
{
  const N = 9;
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...self.matchAll(/^\/\/ --- Criterion (\d+):/gim)].map((m) => Number(m[1]));
  assert.equal(markers.length, new Set(markers).size, "each criterion tested exactly once");
  assert.equal(markers.length, N, `exactly ${N} criteria are tested`);
  for (let n = 1; n <= N; n++) assert.ok(markers.includes(n), `criterion ${n} has a test`);
}

console.log("PASS ratchet-start.test.mjs (9 criteria)");
