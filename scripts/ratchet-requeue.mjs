#!/usr/bin/env node
// ratchet-requeue.mjs — return an issue to the queue, deterministically.
// An agent that fails its gates or finds an issue over-scope hands it back:
// post a comment saying why, add state:ready, strip the in-flight state label.
// Done by hand this corrupts the state machine when half-applied (a flip with
// no comment, or two state labels at once). This makes it one command with a
// strict order: comment FIRST, then a single label write, so an interrupted run
// never leaves an unexplained state change.
//
// GitHub access goes through the shared gh-api.mjs client (resolveAuth/ghClient)
// — no private fetch client, no token resolution here.
//
// Usage:  node scripts/ratchet-requeue.mjs --issue <N> --reason "<text>"
// Output: exactly one line of JSON to stdout with a stable `result` field.
// Exit:   0 success, 2 invalid arguments (usage to stderr), 1 API failure.
// Zero dependencies. Node 20+ (ESM).

import { fileURLToPath } from "node:url";
import { ghClient, paginate, resolveAuth } from "./gh-api.mjs";

// Tags a comment as a requeue notice so a re-run recognises its own prior
// comment and does not post a duplicate.
export const REQUEUE_MARKER = "<!-- ratchet-requeue -->";

const USAGE = 'usage: ratchet-requeue.mjs --issue <N> --reason "<text>"';
const labelNames = (labels) => (labels || []).map((l) => (typeof l === "string" ? l : l.name));
const usageErr = (msg) => Object.assign(new Error(msg), { usage: true });

// Parse `--issue <N> --reason <text>`, both `--k v` and `--k=v`. Returns
// { issue, reason } or throws a usage Error (exit 2) on any missing, malformed,
// or unknown argument — invalid input never reaches the API.
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    let key = argv[i];
    let val;
    const eq = key.indexOf("=");
    if (key.startsWith("--") && eq !== -1) [key, val] = [key.slice(0, eq), key.slice(eq + 1)];
    else if (key === "--issue" || key === "--reason") val = argv[++i];
    if (key === "--issue") opts.issue = val;
    else if (key === "--reason") opts.reason = val;
    else throw usageErr(`unknown argument: ${argv[i]}`);
  }
  const issue = Number(opts.issue);
  if (!opts.issue || !Number.isInteger(issue) || issue <= 0)
    throw usageErr("`--issue <N>` is required and must be a positive integer");
  if (!opts.reason || !opts.reason.trim())
    throw usageErr("`--reason <text>` is required and must be non-empty");
  return { issue, reason: opts.reason };
}

// Run the requeue. Prints exactly one JSON line via `out`, returns the exit
// code. `auth`/`fetchImpl`/`out`/`err` are injectable for off-network testing.
export async function run({
  argv = process.argv.slice(2),
  auth = resolveAuth,
  fetchImpl,
  out = console.log,
  err = console.error,
} = {}) {
  let issue, reason;
  try {
    ({ issue, reason } = parseArgs(argv));
  } catch (e) {
    err(USAGE);
    out(JSON.stringify({ result: "invalid-args", error: e.message }));
    return 2;
  }

  try {
    const { token, repo } = auth();
    const gh = ghClient(token, { fetchImpl });

    // Comment FIRST — an interrupted run can only leave an explained no-op
    // (comment, old label), never an unexplained label flip. Skip if a prior
    // requeue comment with this reason already exists (idempotent).
    const comments = await paginate(gh, `/repos/${repo}/issues/${issue}/comments`);
    const already = comments.some(
      (c) => (c.body || "").includes(REQUEUE_MARKER) && (c.body || "").includes(reason),
    );
    if (!already)
      await gh("POST", `/repos/${repo}/issues/${issue}/comments`, { body: `${reason}\n\n${REQUEUE_MARKER}` });

    // Single label write: strip every state:* label, add state:ready. One PUT
    // sets the whole set atomically — no partial state, always exactly one
    // state label, and a re-run is a no-op.
    const info = await gh("GET", `/repos/${repo}/issues/${issue}`);
    const kept = labelNames(info.labels).filter((l) => !l.startsWith("state:"));
    kept.push("state:ready");
    await gh("PUT", `/repos/${repo}/issues/${issue}/labels`, { labels: kept });

    out(JSON.stringify({ result: "requeued", issue, state: "state:ready", commented: !already }));
    return 0;
  } catch (e) {
    // Single-line JSON error; no partial label state is possible because the
    // label write is one atomic PUT that either wholly succeeds or never ran.
    out(JSON.stringify({ result: "error", issue, error: String(e.message).split("\n")[0] }));
    return 1;
  }
}

// Auto-run only when executed directly, never on import (the test drives run()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  run().then((code) => process.exit(code));
