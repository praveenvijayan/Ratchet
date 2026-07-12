#!/usr/bin/env node
// ratchet-submit.mjs — the PR handoff, deterministically.
// Bundles the preflight most often fumbled from prose: current origin/main is
// integrated, the gates pass fail-fast, conflicted or red work is refused
// before it can waste a review, the branch is pushed, the single PR is kept (or
// created), and labels flip to state:in-review. The PR summary itself stays
// model-authored — the caller supplies it via --body-file.
//
// GitHub access goes through the shared gh-api.mjs client (resolveAuth/ghClient)
// — no private fetch client, no token resolution here. git and the gate runner
// are injectable so the whole preflight is tested off the network.
//
// Usage:  node scripts/ratchet-submit.mjs --issue <N> --body-file <path>
// Output: exactly one line of JSON to stdout with a stable `result` field.
// Exit:   0 success/idempotent, 2 invalid args or bad body first line,
//         4 not integrated / would conflict, 5 red gate, 1 API/other failure.
// Zero dependencies. Node 20+ (ESM).

import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ghClient, resolveAuth } from "./gh-api.mjs";

const usageErr = (msg) => Object.assign(new Error(msg), { usage: true });
const labelNames = (labels) => (labels || []).map((l) => (typeof l === "string" ? l : l.name));
const USAGE = "usage: ratchet-submit.mjs --issue <N> --body-file <path>";

// Parse `--issue <N> --body-file <path>`, both `--k v` and `--k=v`. Throws a
// usage Error (exit 2) on any missing, malformed, or unknown argument.
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    let key = argv[i];
    let val;
    const eq = key.indexOf("=");
    if (key.startsWith("--") && eq !== -1) [key, val] = [key.slice(0, eq), key.slice(eq + 1)];
    else if (key === "--issue" || key === "--body-file") val = argv[++i];
    if (key === "--issue") opts.issue = val;
    else if (key === "--body-file") opts.bodyFile = val;
    else throw usageErr(`unknown argument: ${argv[i]}`);
  }
  const issue = Number(opts.issue);
  if (!opts.issue || !Number.isInteger(issue) || issue <= 0)
    throw usageErr("`--issue <N>` is required and must be a positive integer");
  if (!opts.bodyFile) throw usageErr("`--body-file <path>` is required");
  return { issue, bodyFile: opts.bodyFile };
}

// Default git runner: run `git <args>` and return { code, stdout }. A non-zero
// exit is captured, never thrown, so callers branch on `code`.
function gitDefault(args) {
  try {
    return { code: 0, stdout: execFileSync("git", args, { encoding: "utf8" }) };
  } catch (e) {
    return { code: e.status ?? 1, stdout: (e.stdout || "").toString() };
  }
}

// Default gate runner: run the GATES.md gates as a child process, inheriting
// stdio so the agent sees the same output, and return its exit code (0 = green).
function gatesDefault() {
  return spawnSync("node", ["scripts/run-gates.mjs"], { stdio: "inherit" }).status ?? 1;
}

// Is origin/main an ancestor of HEAD (branch already contains current main)?
// If not, decide whether merging main would conflict, so the caller can report
// "not-integrated" vs "conflict" — both refuse the push.
function integration(runGit) {
  if (runGit(["merge-base", "--is-ancestor", "origin/main", "HEAD"]).code === 0) return "integrated";
  const mt = runGit(["merge-tree", "--write-tree", "origin/main", "HEAD"]);
  return mt.code !== 0 || /^(<<<<<<<|CONFLICT)/m.test(mt.stdout) ? "conflict" : "not-integrated";
}

// Run the handoff. Prints exactly one JSON line via `out`, returns the exit
// code. Every dependency is injectable for off-network testing.
export async function run({
  argv = process.argv.slice(2),
  auth = resolveAuth,
  fetchImpl,
  runGit = gitDefault,
  runGates = gatesDefault,
  readBody = (p) => readFileSync(p, "utf8"),
  out = console.log,
  err = console.error,
} = {}) {
  let issue, bodyFile;
  try {
    ({ issue, bodyFile } = parseArgs(argv));
  } catch (e) {
    err(USAGE);
    out(JSON.stringify({ result: "invalid-args", error: e.message }));
    return 2;
  }

  const emit = (obj, code) => {
    out(JSON.stringify({ ...obj, issue }));
    return code;
  };

  try {
    // Body must open with exactly `Closes #<N>` so the merge closes the issue.
    let body;
    try {
      body = readBody(bodyFile);
    } catch {
      err(USAGE);
      return emit({ result: "invalid-args", error: `cannot read body file: ${bodyFile}` }, 2);
    }
    if (body.split("\n")[0].trim() !== `Closes #${issue}`)
      return emit({ result: "bad-body", error: `first line must be exactly "Closes #${issue}"` }, 2);

    // Refuse un-integrated or conflicting work before any push.
    runGit(["fetch", "origin", "main"]);
    const integ = integration(runGit);
    if (integ !== "integrated") return emit({ result: integ }, 4);

    // Gates fail-fast; a red gate means nothing is pushed.
    if (runGates() !== 0) return emit({ result: "red-gate" }, 5);

    const branch = `agent/issue-${issue}`;
    const push = runGit(["push", "-u", "origin", branch]);
    if (push.code !== 0) return emit({ result: "error", error: "push failed" }, 1);

    const { token, repo } = auth();
    const gh = ghClient(token, { fetchImpl });
    const owner = repo.split("/")[0];

    // Keep the single PR: create only when none is open for this head branch.
    const existing = await gh("GET", `/repos/${repo}/pulls?head=${owner}:${branch}&state=open`);
    let created = false;
    if (!existing.length) {
      const info = await gh("GET", `/repos/${repo}/issues/${issue}`);
      await gh("POST", `/repos/${repo}/pulls`, { title: info.title, head: branch, base: "main", body });
      created = true;
    }

    // Flip to state:in-review — strip every state:* label, add in-review.
    const info = await gh("GET", `/repos/${repo}/issues/${issue}`);
    const kept = labelNames(info.labels).filter((l) => !l.startsWith("state:"));
    kept.push("state:in-review");
    await gh("PUT", `/repos/${repo}/issues/${issue}/labels`, { labels: kept });

    return emit({ result: created ? "submitted" : "already-submitted", state: "state:in-review" }, 0);
  } catch (e) {
    return emit({ result: "error", error: String(e.message).split("\n")[0] }, 1);
  }
}

// Auto-run only when executed directly, never on import (the test drives run()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  run().then((code) => process.exit(code));
