#!/usr/bin/env node
// ratchet-start.mjs — the claim, deterministically.
// Replaces the most fragile prose procedure in AGENTS.md (server-side ref CAS,
// worktree attach, owner marker, info/exclude registration, label flip,
// self-assign) with one low-freedom command (plan 0144). The claim ref is
// created server-side off current origin/main BEFORE any local mutation, so a
// lost CAS (HTTP 422) leaves nothing local behind. Local attachment is a
// worktree only; the shared clone's branch is never changed.
//
// GitHub access goes through the shared gh-api.mjs client (resolveAuth/ghClient)
// — no private fetch client, no token resolution here. git and the filesystem
// are injectable so the whole claim is tested off the network with no real git,
// no `gh`, and no worktree ever created.
//
// Usage:  node scripts/ratchet-start.mjs --issue <N> --owner "<id>"
// Output: exactly one line of JSON to stdout with a stable `result` field.
// Exit:   0 claimed/resumed, 2 invalid args, 3 foreign (ref exists),
//         4 unsafe (worktree owner mismatch), 1 API/other failure.
// Zero dependencies. Node 20+ (ESM).

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ghClient, resolveAuth } from "./gh-api.mjs";

const usageErr = (msg) => Object.assign(new Error(msg), { usage: true });
const labelNames = (labels) => (labels || []).map((l) => (typeof l === "string" ? l : l.name));
const USAGE = 'usage: ratchet-start.mjs --issue <N> --owner "<id>"';

// Parse `--issue <N> --owner <id>`, both `--k v` and `--k=v`. Throws a usage
// Error (exit 2) on any missing, malformed, or unknown argument.
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    let key = argv[i];
    let val;
    const eq = key.indexOf("=");
    if (key.startsWith("--") && eq !== -1) [key, val] = [key.slice(0, eq), key.slice(eq + 1)];
    else if (key === "--issue" || key === "--owner") val = argv[++i];
    if (key === "--issue") opts.issue = val;
    else if (key === "--owner") opts.owner = val;
    else throw usageErr(`unknown argument: ${argv[i]}`);
  }
  const issue = Number(opts.issue);
  if (!opts.issue || !Number.isInteger(issue) || issue <= 0)
    throw usageErr("`--issue <N>` is required and must be a positive integer");
  if (!opts.owner || !opts.owner.trim()) throw usageErr('`--owner "<id>"` is required');
  return { issue, owner: opts.owner.trim() };
}

// Default git runner: run `git <args>`, returning { code, stdout }. A non-zero
// exit is captured, never thrown, so callers branch on `code`.
function gitDefault(args) {
  try {
    return { code: 0, stdout: execFileSync("git", args, { encoding: "utf8" }) };
  } catch (e) {
    return { code: e.status ?? 1, stdout: (e.stdout || "").toString() };
  }
}

// The owner id in a `.ratchet-owner` marker is everything before its ` issue-<N>`
// suffix (the format AGENTS.md and this script write). "" for an empty marker so
// a missing owner never matches.
export function markerOwner(text) {
  return String(text || "").split(/\s+issue-/)[0].trim();
}

const defaultFs = { existsSync, readFileSync, writeFileSync, appendFileSync };

// Run the claim. Prints exactly one JSON line via `out`, returns the exit code.
// Every dependency is injectable for off-network testing.
export async function run({
  argv = process.argv.slice(2),
  auth = resolveAuth,
  fetchImpl,
  runGit = gitDefault,
  fs = defaultFs,
  out = console.log,
  err = console.error,
  now = () => new Date().toISOString(),
} = {}) {
  let issue, owner;
  try {
    ({ issue, owner } = parseArgs(argv));
  } catch (e) {
    err(USAGE);
    out(JSON.stringify({ result: "invalid-args", error: e.message }));
    return 2;
  }

  const branch = `agent/issue-${issue}`;
  const worktree = `../wt/issue-${issue}`;
  const emit = (obj, code) => (out(JSON.stringify({ ...obj, issue, owner })), code);

  try {
    // Resume/safety gate first — before any mutation. An existing worktree means
    // this issue is already attached: reuse it when the recorded owner matches
    // (idempotent — running twice equals running once), refuse with no mutation
    // when it does not (foreign work is untouchable).
    if (fs.existsSync(worktree)) {
      let marker = "";
      try { marker = fs.readFileSync(join(worktree, ".ratchet-owner"), "utf8"); } catch { marker = ""; }
      if (markerOwner(marker) !== owner)
        return emit({ result: "unsafe", error: "worktree is owned by a different owner id" }, 4);
      return emit({ result: "resumed", branch, worktree }, 0);
    }

    const { token, repo } = auth();
    const gh = ghClient(token, { fetchImpl });

    // Claim = create the branch ref server-side off current origin/main. This is
    // the FIRST mutation and it is remote: a 422 means the ref already exists —
    // the claim is foreign and nothing local has been touched.
    const mainRef = await gh("GET", `/repos/${repo}/git/ref/heads/main`);
    try {
      await gh("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: mainRef.object.sha });
    } catch (e) {
      if (e.status === 422) return emit({ result: "foreign", error: "claim ref already exists" }, 3);
      throw e;
    }

    // Ref is ours. Attach locally as a worktree — never a checkout in the shared
    // clone. Fetch the ref, add the worktree, then immediately write the owner
    // marker so a worktree never exists without its marker.
    if (runGit(["fetch", "origin", branch]).code !== 0) return emit({ result: "error", error: `git fetch ${branch} failed` }, 1);
    if (runGit(["worktree", "add", worktree, branch]).code !== 0) return emit({ result: "error", error: "git worktree add failed" }, 1);
    fs.writeFileSync(join(worktree, ".ratchet-owner"), `${owner} issue-${issue} claimed ${now()}\n`);

    // Register the marker in the shared exclude (append only when absent) so it
    // is never a tracked file in any worktree.
    const common = runGit(["rev-parse", "--git-common-dir"]);
    if (common.code === 0) {
      const excludePath = join(common.stdout.trim(), "info", "exclude");
      let excluded = "";
      try { excluded = fs.readFileSync(excludePath, "utf8"); } catch { excluded = ""; }
      if (!excluded.split("\n").some((l) => l.trim() === ".ratchet-owner")) fs.appendFileSync(excludePath, ".ratchet-owner\n");
    }

    // Report state:in-progress (strip every other state:* label), then self-assign.
    const info = await gh("GET", `/repos/${repo}/issues/${issue}`);
    const kept = labelNames(info.labels).filter((l) => !l.startsWith("state:"));
    kept.push("state:in-progress");
    await gh("PUT", `/repos/${repo}/issues/${issue}/labels`, { labels: kept });
    const me = await gh("GET", "/user");
    await gh("POST", `/repos/${repo}/issues/${issue}/assignees`, { assignees: [me.login] });

    return emit({ result: "claimed", branch, worktree, state: "state:in-progress", assignee: me.login }, 0);
  } catch (e) {
    return emit({ result: "error", error: String(e.message).split("\n")[0] }, 1);
  }
}

// Auto-run only when executed directly, never on import (the test drives run()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  run().then((code) => process.exit(code));
