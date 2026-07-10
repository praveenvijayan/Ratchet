#!/usr/bin/env node
// herd-retention.mjs — bounds the growth of the two append-only herd files that
// pruneLogs (herd-survey.mjs) does not cover: the event stream
// (.ratchet/events.jsonl) and the escalation log (.ratchet/herd-escalations.md).
// Both are appended to on every poll and never rewritten, so a long-running herd
// accumulates megabytes the dashboard must re-parse on each request. This stage
// prunes them each poll, using the same retention knob as worker logs
// (`config.logRetentionDays`, validated by normalizeConfig — an invalid value
// fails config load naming the file and field).
//
// The prune is conservative on both files:
//   - Events: a line older than the window is dropped, EXCEPT one whose issue has
//     a live worker in the state file — its history is kept regardless of age. An
//     undated or unparseable line is always kept (never silently lose data).
//   - Escalations: a block is dropped only when it is BOTH older than the window
//     AND resolved per the 0082 resolution model (resolveEscalations): a
//     stale-claim escalation whose ref is gone, or a PR-concluded escalation whose
//     issue has since closed. An unresolved escalation is never pruned regardless
//     of age — a live alert must never age out. Blocks are sliced from the raw
//     text so multi-line log tails survive verbatim; nothing is re-serialized.
//
// Like the rest of herd this stage never merges, approves, closes, or labels — it
// only reads issue state (to derive resolution) and rewrites the two local files.
// Every outside-world call is injectable, so it runs offline in tests. Zero deps.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { STATE_FILE, EVENTS_FILE, ESCALATIONS_FILE, readState, isPidAlive } from "./herd-survey.mjs";
import { resolveEscalations } from "./herd-ui.mjs";

const DAY_MS = 86400 * 1000;

// The escalation heading the survey writes: `## <iso-ts> — issue #<N>`. Each block
// runs from its heading to the next heading (or end of file).
const HEAD_RE = /^##[ \t]+(\S+)[ \t]+—[ \t]+issue #(\d+)[ \t]*$/gim;

// Split the escalation markdown into file-order blocks, each carrying its raw text
// (heading through the line before the next heading) so a prune preserves exact
// formatting — multi-line "What happened" log tails included. Returns
// { preamble, blocks } where preamble is any text before the first heading.
export function scanEscalationBlocks(md) {
  HEAD_RE.lastIndex = 0;
  const heads = [];
  let m;
  while ((m = HEAD_RE.exec(md)) !== null) heads.push({ ts: m[1], issue: Number(m[2]), start: m.index });
  const preamble = heads.length ? md.slice(0, heads[0].start) : md;
  const blocks = heads.map((h, i) => ({
    ts: h.ts,
    issue: h.issue,
    raw: md.slice(h.start, i + 1 < heads.length ? heads[i + 1].start : md.length),
  }));
  return { preamble, blocks };
}

// Rewrite events.jsonl, dropping lines older than the retention window unless their
// issue still has a live worker. Undated/unparseable lines are kept. FS errors are
// swallowed so a poll never crashes on log hygiene. Returns the count pruned.
export function pruneEvents({ eventsPath = EVENTS_FILE, retentionDays, state = {}, isAlive = isPidAlive, now = Date.now() }) {
  if (!eventsPath || !existsSync(eventsPath)) return 0;
  let text;
  try {
    text = readFileSync(eventsPath, "utf8");
  } catch {
    return 0;
  }
  const cutoff = now - retentionDays * DAY_MS;
  const liveIssues = new Set(
    Object.entries(state)
      .filter(([, e]) => e && e.pid != null && isAlive(e.pid))
      .map(([issue]) => Number(issue)),
  );
  const kept = [];
  let pruned = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue; // the trailing newline's empty tail (and blank lines)
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      kept.push(line); // never discard a line we cannot classify
      continue;
    }
    const tsMs = ev.ts ? Date.parse(ev.ts) : NaN;
    const undated = !Number.isFinite(tsMs);
    const withinWindow = !undated && tsMs >= cutoff;
    const liveWorker = ev.issue != null && liveIssues.has(Number(ev.issue));
    if (undated || withinWindow || liveWorker) {
      kept.push(line);
      continue;
    }
    pruned++;
  }
  if (pruned === 0) return 0;
  try {
    writeFileSync(eventsPath, kept.length ? kept.join("\n") + "\n" : "");
  } catch {
    return 0;
  }
  return pruned;
}

// Rewrite herd-escalations.md, dropping only blocks that are both older than the
// window and resolved per the 0082 model. `closedIssues` supplies the closed-issue
// resolution the state file cannot. FS errors are swallowed. Returns the count of
// blocks pruned.
export function pruneEscalations({ escalationsPath = ESCALATIONS_FILE, retentionDays, state = {}, closedIssues = new Set(), now = Date.now() }) {
  if (!escalationsPath || !existsSync(escalationsPath)) return 0;
  let md;
  try {
    md = readFileSync(escalationsPath, "utf8");
  } catch {
    return 0;
  }
  const { preamble, blocks } = scanEscalationBlocks(md);
  if (blocks.length === 0) return 0;
  const cutoff = now - retentionDays * DAY_MS;
  // Resolution keys off the raw block text (the resolve model matches on the
  // "What happened" wording, which lives in the block); pass it as `what`.
  const resolved = resolveEscalations(
    blocks.map((b) => ({ issue: b.issue, what: b.raw })),
    { state, closedIssues },
  );
  const kept = [];
  let pruned = 0;
  for (let i = 0; i < blocks.length; i++) {
    const tsMs = Date.parse(blocks[i].ts);
    const old = Number.isFinite(tsMs) && tsMs < cutoff;
    if (old && resolved[i].resolved) {
      pruned++;
      continue;
    }
    kept.push(blocks[i].raw);
  }
  if (pruned === 0) return 0;
  try {
    writeFileSync(escalationsPath, preamble + kept.join(""));
  } catch {
    return 0;
  }
  return pruned;
}

// Resolving a PR-concluded escalation needs to know its issue has closed — state
// the state file does not carry. Gather it with one bounded `gh issue view` per
// distinct issue, and only for OLD, PR-concluded blocks (recent blocks are kept by
// age regardless, and stale-claim blocks resolve from state alone). A failed
// lookup leaves that issue unresolved, so its blocks are simply kept this poll.
export async function gatherClosedIssues({ gh, escalationsPath = ESCALATIONS_FILE, retentionDays, now = Date.now(), log = console.log }) {
  const closed = new Set();
  if (!gh || !existsSync(escalationsPath)) return closed;
  let md;
  try {
    md = readFileSync(escalationsPath, "utf8");
  } catch {
    return closed;
  }
  const cutoff = now - retentionDays * DAY_MS;
  const { blocks } = scanEscalationBlocks(md);
  const candidates = new Set();
  for (const b of blocks) {
    const tsMs = Date.parse(b.ts);
    if (!Number.isFinite(tsMs) || tsMs >= cutoff) continue; // recent — protected by age anyway
    if (/is no longer open/.test(b.raw) && !/stale claim ref/.test(b.raw)) candidates.add(b.issue);
  }
  for (const issue of candidates) {
    try {
      const data = await gh(["issue", "view", String(issue), "--json", "state"]);
      if (data && data.state === "CLOSED") closed.add(issue);
    } catch (e) {
      log(`herd: retention — issue #${issue} state lookup failed: ${e.message}; leaving its escalations unpruned this poll.`);
    }
  }
  return closed;
}

// One retention pass: prune the event stream and the escalation log against the
// retention window, reporting the counts on a poll summary line. Returns
// { ok, prunedEvents, prunedEscalations }.
export async function retentionOnce(opts) {
  const {
    config,
    statePath = STATE_FILE,
    eventsPath = EVENTS_FILE,
    escalationsPath = ESCALATIONS_FILE,
    gh,
    isAlive = isPidAlive,
    now = () => Date.now(),
    log = console.log,
  } = opts;
  const retentionDays = config.logRetentionDays;
  const stamp = now();
  const state = readState(statePath);

  const prunedEvents = pruneEvents({ eventsPath, retentionDays, state, isAlive, now: stamp });
  const closedIssues = await gatherClosedIssues({ gh, escalationsPath, retentionDays, now: stamp, log });
  const prunedEscalations = pruneEscalations({ escalationsPath, retentionDays, state, closedIssues, now: stamp });

  if (prunedEvents || prunedEscalations) {
    log(`herd: retention — pruned ${prunedEvents} event line(s) and ${prunedEscalations} escalation block(s) older than ${retentionDays}d`);
  }
  return { ok: true, prunedEvents, prunedEscalations };
}
