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
// The notice is also an ATTEMPT RECORD: the same single comment carries a
// machine-readable marker (attempt number, owner, gate, reason) so the next
// claimant can read what was already tried instead of repeating a dead end.
//
// Usage:  node scripts/ratchet-requeue.mjs --issue <N> --reason "<text>"
//                                          [--gate "<name>"] [--owner "<id>"]
// Output: exactly one line of JSON to stdout with a stable `result` field.
// Exit:   0 success, 2 invalid arguments (usage to stderr), 1 API failure.
// Zero dependencies. Node 20+ (ESM).

import { fileURLToPath } from "node:url";
import { ghClient, paginate, resolveAuth } from "./gh-api.mjs";

// Tags a comment as a requeue notice so a re-run recognises its own prior
// comment and does not post a duplicate. Kept verbatim on every record — pre-
// record comments (and herd's recoverClaim) carry only this, and still count.
export const REQUEUE_MARKER = "<!-- ratchet-requeue -->";

// Opens the structured half of the notice: `<!-- ratchet-attempt {json} -->`.
export const ATTEMPT_MARKER = "<!-- ratchet-attempt";

// The record marker owns a whole line of its own, and the LAST such line wins:
// the reason is human text that may itself quote a marker, but this script
// always appends the real one last, so smuggled prose can never outrank it.
const ATTEMPT_RE = /^<!--\s*ratchet-attempt\s+(\{.*?\})\s*-->$/gm;
const ATTEMPT_STRIP_RE = /^<!--\s*ratchet-attempt\s+.*-->$/gm;

function lastPayload(text) {
  let match;
  let payload = null;
  ATTEMPT_RE.lastIndex = 0;
  while ((match = ATTEMPT_RE.exec(text))) payload = match[1];
  return payload;
}

const USAGE =
  'usage: ratchet-requeue.mjs --issue <N> --reason "<text>" [--gate "<name>"] [--owner "<id>"]';
const FLAGS = new Set(["--issue", "--reason", "--gate", "--owner"]);
const labelNames = (labels) => (labels || []).map((l) => (typeof l === "string" ? l : l.name));
const usageErr = (msg) => Object.assign(new Error(msg), { usage: true });

// Serialise a record into the marker. `<` and `>` become JSON `\u00XX` escapes
// so no reason — however hostile — can close the HTML comment early or smuggle
// a second marker in; JSON.stringify already flattens newlines and quotes, so
// the marker is always exactly one line that round-trips through JSON.parse.
export function encodeAttemptRecord({ attempt, owner = null, gate = null, reason = "" }) {
  const payload = { attempt, ...(owner ? { owner } : {}), ...(gate ? { gate } : {}), reason };
  const json = JSON.stringify(payload).replace(/[<>]/g, (c) => (c === "<" ? "\\u003c" : "\\u003e"));
  return `${ATTEMPT_MARKER} ${json} -->`;
}

// Everything in a legacy notice that is not a marker is its reason.
const legacyReason = (body) =>
  String(body).replace(ATTEMPT_STRIP_RE, "").split(REQUEUE_MARKER).join("").trim();

// One comment body → an attempt record, or null when the comment is not a
// requeue notice at all (heartbeat, human prose). A body whose marker payload
// is unparseable degrades to a legacy record rather than throwing: a corrupted
// field must never make the whole ledger unreadable.
export function parseAttemptRecord(body) {
  const text = String(body ?? "");
  const payload = lastPayload(text);
  if (payload !== null) {
    try {
      const d = JSON.parse(payload);
      return {
        attempt: Number.isInteger(d.attempt) && d.attempt > 0 ? d.attempt : null,
        owner: typeof d.owner === "string" ? d.owner : null,
        gate: typeof d.gate === "string" ? d.gate : null,
        reason: typeof d.reason === "string" ? d.reason : "",
        legacy: false,
      };
    } catch {
      // fall through to the legacy reading below
    }
  }
  if (!text.includes(REQUEUE_MARKER)) return null;
  return { attempt: null, owner: null, gate: null, reason: legacyReason(text), legacy: true };
}

// The issue's attempt ledger: every requeue notice in its comment stream, in
// the order GitHub returns them (oldest first), non-notices dropped. A record
// with no recorded number (a pre-record comment) takes its ordinal position.
export function parseAttemptRecords(comments = []) {
  const records = [];
  for (const c of comments) {
    const record = parseAttemptRecord(c && typeof c === "object" ? c.body : c);
    if (record) records.push({ ...record, attempt: record.attempt ?? records.length + 1 });
  }
  return records;
}

// Parse `--issue <N> --reason <text> [--gate <name>] [--owner <id>]`, both
// `--k v` and `--k=v`. Returns { issue, reason, gate, owner } or throws a usage
// Error (exit 2) on any missing, malformed, empty, or unknown argument —
// invalid input never reaches the API.
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    let key = raw;
    let val;
    const eq = key.indexOf("=");
    if (key.startsWith("--") && eq !== -1) [key, val] = [key.slice(0, eq), key.slice(eq + 1)];
    else if (FLAGS.has(key)) val = argv[++i];
    if (!FLAGS.has(key)) throw usageErr(`unknown argument: ${raw}`);
    opts[key.slice(2)] = val;
  }
  const issue = Number(opts.issue);
  if (!opts.issue || !Number.isInteger(issue) || issue <= 0)
    throw usageErr("`--issue <N>` is required and must be a positive integer");
  if (!opts.reason || !opts.reason.trim())
    throw usageErr("`--reason <text>` is required and must be non-empty");
  for (const flag of ["gate", "owner"])
    if (flag in opts && !String(opts[flag] ?? "").trim())
      throw usageErr(`\`--${flag} <value>\` must be non-empty when given`);
  return { issue, reason: opts.reason, gate: opts.gate ?? null, owner: opts.owner ?? null };
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
  let issue, reason, gate, owner;
  try {
    ({ issue, reason, gate, owner } = parseArgs(argv));
  } catch (e) {
    err(USAGE);
    out(JSON.stringify({ result: "invalid-args", error: e.message }));
    return 2;
  }

  try {
    const { token, repo } = auth();
    const gh = ghClient(token, { fetchImpl });

    // Comment FIRST — an interrupted run can only leave an explained no-op
    // (comment, old label), never an unexplained label flip. The comment is
    // the attempt record: prose for the human, marker for the next agent. One
    // comment, one POST — the same call the script always made. Skip it if an
    // identical record is already on the issue (idempotent).
    const comments = await paginate(gh, `/repos/${repo}/issues/${issue}/comments`);
    const records = parseAttemptRecords(comments);
    const existing = records.find((r) => r.reason === reason && r.gate === gate && r.owner === owner);
    const already = Boolean(existing);
    const attempt = existing ? existing.attempt : records.length + 1;
    if (!already) {
      const prose = gate ? `${reason}\n\nFailed gate: \`${gate}\`` : reason;
      const body = `${prose}\n\n${REQUEUE_MARKER}\n${encodeAttemptRecord({ attempt, owner, gate, reason })}`;
      await gh("POST", `/repos/${repo}/issues/${issue}/comments`, { body });
    }

    // Single label write: strip every state:* label, add state:ready. One PUT
    // sets the whole set atomically — no partial state, always exactly one
    // state label, and a re-run is a no-op.
    const info = await gh("GET", `/repos/${repo}/issues/${issue}`);
    const kept = labelNames(info.labels).filter((l) => !l.startsWith("state:"));
    kept.push("state:ready");
    await gh("PUT", `/repos/${repo}/issues/${issue}/labels`, { labels: kept });

    out(JSON.stringify({ result: "requeued", issue, state: "state:ready", commented: !already, attempt }));
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
