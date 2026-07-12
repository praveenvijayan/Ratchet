#!/usr/bin/env node
// ratchet-heartbeat.mjs — renew a claim's lease without pushing code.
// A legitimate build can run past STALE_HOURS with nothing pushed (an agent
// only pushes once the gates are green), indistinguishable from a crash unless
// it signals life. An issue comment carrying HEARTBEAT_MARKER is that signal:
// sweep-stale-claims measures freshness from the newest of a commit, a
// heartbeat, or the claim event, so a fresh heartbeat keeps the claim its
// owner's. The marker is imported from sweep-lease.mjs — the same constant the
// sweep recognises — so the two can never drift.
//
// GitHub access goes through the shared gh-api.mjs client (resolveAuth/ghClient)
// — no private fetch client, no token resolution here.
//
// Usage:  node scripts/ratchet-heartbeat.mjs --issue <N>
// Output: exactly one line of JSON to stdout with a stable `result` field.
// Exit:   0 success, 2 invalid arguments (usage to stderr), 1 API failure.
// Zero dependencies. Node 20+ (ESM).

import { fileURLToPath } from "node:url";
import { ghClient, resolveAuth } from "./gh-api.mjs";
import { HEARTBEAT_MARKER } from "./sweep-lease.mjs";

const USAGE = "usage: ratchet-heartbeat.mjs --issue <N>";
const usageErr = (msg) => Object.assign(new Error(msg), { usage: true });

// Parse `--issue <N>`, both `--issue N` and `--issue=N`. Returns { issue } or
// throws a usage Error (exit 2) on any missing, malformed, or unknown argument.
export function parseArgs(argv) {
  let raw;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith("--issue=")) raw = key.slice(key.indexOf("=") + 1);
    else if (key === "--issue") raw = argv[++i];
    else throw usageErr(`unknown argument: ${key}`);
  }
  const issue = Number(raw);
  if (!raw || !Number.isInteger(issue) || issue <= 0)
    throw usageErr("`--issue <N>` is required and must be a positive integer");
  return { issue };
}

// Post one heartbeat. Prints exactly one JSON line via `out`, returns the exit
// code. Injectable for off-network testing.
export async function run({
  argv = process.argv.slice(2),
  auth = resolveAuth,
  fetchImpl,
  out = console.log,
  err = console.error,
} = {}) {
  let issue;
  try {
    ({ issue } = parseArgs(argv));
  } catch (e) {
    err(USAGE);
    out(JSON.stringify({ result: "invalid-args", error: e.message }));
    return 2;
  }

  try {
    const { token, repo } = auth();
    const gh = ghClient(token, { fetchImpl });
    await gh("POST", `/repos/${repo}/issues/${issue}/comments`, {
      body: `Lease heartbeat — build in progress.\n\n${HEARTBEAT_MARKER}`,
    });
    out(JSON.stringify({ result: "heartbeat", issue }));
    return 0;
  } catch (e) {
    out(JSON.stringify({ result: "error", issue, error: String(e.message).split("\n")[0] }));
    return 1;
  }
}

// Auto-run only when executed directly, never on import (the test drives run()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  run().then((code) => process.exit(code));
